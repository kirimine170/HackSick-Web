type CallApi = <T>(path: string, body?: unknown) => Promise<T>;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const message = (error: unknown) => error instanceof Error ? error.message : "処理を完了できませんでした．";

export function initMemberPass(api: CallApi) {
  const panel = el("member-pass");
  const display = el("member-pass-display");
  const canvas = el<HTMLCanvasElement>("member-pass-qr");
  const button = el<HTMLButtonElement>("member-pass-show");
  const status = el("member-pass-status");
  let token = "";
  let timer: number | undefined;

  function clearPass() {
    window.clearTimeout(timer);
    token = "";
    display.hidden = true;
    canvas.width = 0;
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    clearPass();
    status.textContent = "会員QRを発行しています．";
    try {
      const { default: QRCode } = await import("qrcode");
      const pass = await api<{ token: string; expiresAt: number }>("/api/member-pass", {});
      if (panel.hidden) return;
      await QRCode.toCanvas(canvas, pass.token, { width: 256, margin: 4, errorCorrectionLevel: "M" });
      token = pass.token;
      display.hidden = false;
      button.textContent = "会員QRを更新";
      status.textContent = "発行から2分以内に，このQRを受付で提示してください．";
      timer = window.setTimeout(() => {
        clearPass();
        status.textContent = "会員QRの有効期限が切れました．更新してください．";
      }, Math.max(0, pass.expiresAt - Date.now()));
    } catch (error) {
      status.textContent = message(error);
    } finally {
      button.disabled = false;
    }
  });

  el("member-pass-copy").addEventListener("click", async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      status.textContent = "受付用コードをコピーしました．";
    } catch {
      status.textContent = "コピーできませんでした．画面のQRを受付で提示してください．";
    }
  });

  return (eligible: boolean) => {
    panel.hidden = !eligible;
    if (!eligible) clearPass();
  };
}

type CheckInResult = {
  displayName: string;
  qualifications: string[];
  month: string;
  eligible: boolean;
  allowed: boolean;
  reason: string | null;
};

export function initLtCheckIn(api: CallApi) {
  const panel = el("lt-check-in");
  const eventField = el<HTMLInputElement>("lt-event-id");
  const tokenField = el<HTMLInputElement>("lt-pass-token");
  const fileField = el<HTMLInputElement>("lt-scan-file");
  const status = el("lt-check-in-status");
  const result = el("lt-check-in-result");
  const record = el<HTMLButtonElement>("lt-check-in-record");
  const previewButton = el<HTMLButtonElement>("lt-check-preview");
  const video = el<HTMLVideoElement>("lt-scan-video");
  const start = el<HTMLButtonElement>("lt-scan-start");
  const stop = el<HTMLButtonElement>("lt-scan-stop");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let stream: MediaStream | null = null;
  let frameTimer: number | undefined;
  let cameraGeneration = 0;
  let revision = 0;
  let pending: { token: string; eventId: string; month: string } | null = null;

  function clearResult() {
    revision++;
    pending = null;
    result.hidden = true;
    record.hidden = true;
  }

  function stopCamera() {
    cameraGeneration++;
    window.clearTimeout(frameTimer);
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    video.hidden = true;
    start.disabled = false;
    stop.hidden = true;
  }

  async function preview(rawToken: string) {
    if (panel.hidden || !eventField.reportValidity()) return;
    const token = rawToken.trim();
    const eventId = eventField.value.trim();
    stopCamera();
    clearResult();
    if (!token || !eventId) {
      status.textContent = "開催回と会員QRを確認してください．";
      return;
    }
    const requestRevision = revision;
    previewButton.disabled = true;
    status.textContent = "会員資格を確認しています．";
    try {
      const data = await api<CheckInResult>("/api/admin/lt/check-in", { token, eventId });
      if (requestRevision !== revision || panel.hidden) return;
      el("lt-check-in-name").textContent = data.displayName;
      const qualification = data.qualifications.map(kind => kind === "MONTHLY" ? "月額会員" : "HSAP").join("・");
      el("lt-check-in-qualification").textContent = data.eligible ? `有効な会員資格　${qualification}` : "有効な会員資格なし";
      result.hidden = false;
      record.hidden = !data.allowed;
      if (data.allowed) pending = { token, eventId, month: data.month };
      status.textContent = data.allowed ? `${data.month}の参加費を免除できます．` : data.reason;
    } catch (error) {
      if (requestRevision === revision) status.textContent = message(error);
    } finally {
      previewButton.disabled = false;
    }
  }

  function decodeFrame(source: CanvasImageSource, width: number, height: number, decode: typeof import("jsqr").default) {
    if (!context || !width || !height) return null;
    const scale = Math.min(1, 960 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const frame = context.getImageData(0, 0, canvas.width, canvas.height);
    return decode(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" })?.data ?? null;
  }

  start.addEventListener("click", async () => {
    if (panel.hidden || !eventField.reportValidity()) return;
    clearResult();
    stopCamera();
    const generation = cameraGeneration;
    start.disabled = true;
    stop.hidden = false;
    status.textContent = "カメラの利用を許可してください．";
    try {
      if (!navigator.mediaDevices?.getUserMedia || !context) throw new Error("カメラを利用できません．");
      const { default: decode } = await import("jsqr");
      if (generation !== cameraGeneration) return;
      const camera = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" } } });
      if (generation !== cameraGeneration) {
        camera.getTracks().forEach(track => track.stop());
        return;
      }
      stream = camera;
      video.srcObject = stream;
      video.hidden = false;
      await video.play();
      if (generation !== cameraGeneration) return;
      status.textContent = "会員QRをカメラに映してください．";
      const scan = () => {
        if (generation !== cameraGeneration) return;
        try {
          const token = decodeFrame(video, video.videoWidth, video.videoHeight, decode);
          if (token) { void preview(token); return; }
          frameTimer = window.setTimeout(scan, 140);
        } catch {
          stopCamera();
          status.textContent = "カメラの読み取りに失敗しました．QR画像か受付用コードをお試しください．";
        }
      };
      scan();
    } catch {
      if (generation !== cameraGeneration) return;
      stopCamera();
      status.textContent = "カメラを利用できませんでした．QR画像か受付用コードをお試しください．";
    }
  });

  stop.addEventListener("click", () => { stopCamera(); status.textContent = "カメラを停止しました．"; });
  fileField.addEventListener("change", async () => {
    const file = fileField.files?.[0];
    fileField.value = "";
    if (!file || !eventField.reportValidity()) return;
    stopCamera();
    clearResult();
    const requestRevision = revision;
    if (file.size > 10 * 1024 * 1024) {
      status.textContent = "10MB以下のQR画像を選択してください．";
      return;
    }
    try {
      const { default: decode } = await import("jsqr");
      const bitmap = await createImageBitmap(file);
      let token: string | null;
      try { token = decodeFrame(bitmap, bitmap.width, bitmap.height, decode); }
      finally { bitmap.close(); }
      if (requestRevision !== revision || panel.hidden) return;
      if (!token) throw new Error("画像から会員QRを読み取れませんでした．");
      await preview(token);
    } catch {
      if (requestRevision === revision) status.textContent = "画像から会員QRを読み取れませんでした．";
    }
  });

  el<HTMLFormElement>("lt-check-in-form").addEventListener("submit", event => {
    event.preventDefault();
    void preview(tokenField.value);
  });
  for (const field of [eventField, tokenField]) field.addEventListener("input", () => {
    clearResult();
    status.textContent = "";
  });

  record.addEventListener("click", async () => {
    if (!pending || panel.hidden) return;
    const requestRevision = revision;
    record.disabled = true;
    try {
      await api("/api/admin/lt/check-in", { ...pending, record: true });
      if (requestRevision !== revision) return;
      pending = null;
      record.hidden = true;
      tokenField.value = "";
      status.textContent = "参加費の免除を記録しました．";
    } catch (error) {
      if (requestRevision !== revision) return;
      pending = null;
      record.hidden = true;
      status.textContent = message(error);
    } finally {
      record.disabled = false;
    }
  });

  document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); });
  window.addEventListener("pagehide", stopCamera);
  return (visible: boolean) => {
    panel.hidden = !visible;
    if (!visible) {
      stopCamera();
      clearResult();
      tokenField.value = "";
      status.textContent = "";
    }
  };
}
