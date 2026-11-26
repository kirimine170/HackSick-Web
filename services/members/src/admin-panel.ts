export const adminPanel = String.raw`
      <div class="section-label"><h2 id="admin-title">会員管理</h2><span>OPERATIONS</span></div>
      <p>会員の本人確認と，資格の根拠を確認してから登録してください．Square契約IDの登録だけでは，会員資格は付与されません．</p>
      <section id="lt-check-in" class="panel" hidden aria-labelledby="lt-check-in-title">
        <p class="eyebrow">EVENT CHECK-IN</p><h3 id="lt-check-in-title">LT会の受付</h3>
        <p>会員QRを読み取り，画面の名前と本人を確認してから，参加費の免除を記録してください．受付月は日本時間で判定します．</p>
        <form id="lt-check-in-form">
          <label for="lt-event-id">イベントID・開催回</label>
          <input id="lt-event-id" maxlength="100" placeholder="例　LT11" required>
          <div class="row check-in-actions">
            <button id="lt-scan-start" type="button">カメラで読み取る</button>
            <button id="lt-scan-stop" type="button" hidden>カメラを停止</button>
          </div>
          <video id="lt-scan-video" class="scan-video" playsinline muted hidden></video>
          <label for="lt-scan-file">QR画像を読み込む</label>
          <input id="lt-scan-file" type="file" accept="image/*">
          <label for="lt-pass-token">受付用コードを貼り付ける</label>
          <div class="row check-in-actions">
            <input id="lt-pass-token" maxlength="516" autocomplete="off" autocapitalize="off" spellcheck="false">
            <button id="lt-check-preview" type="submit">資格を確認する</button>
          </div>
        </form>
        <p id="lt-check-in-status" class="small" role="status"></p>
        <div id="lt-check-in-result" class="entry" hidden>
          <p><strong id="lt-check-in-name"></strong></p>
          <p id="lt-check-in-qualification"></p>
          <button id="lt-check-in-record" type="button" hidden>参加費の免除を記録する</button>
        </div>
      </section>
      <details id="shop-admin" class="panel" hidden><summary>ショップの注文・発送・在庫</summary>
        <p id="square-connection-status"></p><button id="square-connect" type="button">Squareと接続する</button><p class="small">Squareで必要な権限を確認して許可してください．接続はSquareの「アプリ連携」から取り消せます．</p>
        <p id="stock-status"></p>
        <button id="billing-sync" type="button">月額会員の入金を照合する</button><p id="billing-sync-status" role="status" class="small"></p>
        <details><summary>注文と発送メール</summary>
          <p class="small">配送先はSquareの注文で確認してください．クリックポストを投函・引き渡した後，この画面でお問い合わせ番号を登録すると，購入者へ発送メールを送ります．Squareの「発送済みにする」操作も購入者への通知を伴います．</p>
          <button id="admin-orders-refresh" type="button">注文と通知の状況を更新する</button>
          <p id="admin-orders-status" role="status" class="small"></p>
          <div id="admin-orders"></div>
        </details>
        <details id="shop-rules"><summary>限定商品・クーポン・ESSEN担当者</summary>
          <p id="shop-rules-message" role="status"></p>
          <h3>会員の販売ステータス</h3>
          <form id="shop-status-form" class="panel"><label>会員ID<input name="memberId" required></label><label>ステータス（半角英小文字・数字・ハイフン）<input name="status" required pattern="[a-z0-9_-]{1,40}"></label><label>有効期限（任意）<input name="expiresAt" type="datetime-local"></label><div class="row"><button name="action" value="save">付与する</button><button name="action" value="remove">解除する</button></div></form>
          <div id="shop-status-list"></div>
          <h3>商品と販売対象</h3>
          <form id="shop-product-form" class="panel"><label>SKU<input name="sku" required></label><label>Square商品ID<input name="squareItemId" required></label><label>商品名<input name="name" required maxlength="120"></label><label>説明<textarea name="description" required maxlength="2000"></textarea></label><label>税込価格（円）<input name="unitPriceJpy" type="number" min="1" required></label><label>珈琲袋数（その他は0）<input name="bags" type="number" min="0" value="0" required></label><label>対象ステータス（空欄は通常販売）<input name="requiredStatus"></label><label>発送元<select name="fulfillmentSource"><option value="hacksick">HackSick</option><option value="essen">ESSEN</option></select></label><label>商品写真（500KB以内）<input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label><button>商品を保存する</button></form>
          <div id="shop-product-list"></div>
          <h3>クーポン</h3>
          <form id="shop-coupon-form" class="panel"><label>種類<select name="template"><option value="lt">LT参加者・10％</option><option value="supporter">イベント協力者・20％</option><option value="photographer">撮影協力者・50％</option><option value="custom">指定した割引率</option></select></label><label>名称<input name="label" required maxlength="80"></label><label>コード（空欄は自動生成）<input name="code" maxlength="64"></label><label>対象SKU（改行区切り）<textarea name="skus" required></textarea></label><label>利用者のメール（個別コードの場合）<input name="email" type="email"></label><label>有効期限（初期値は発行から30日）<input name="expiresAt" type="datetime-local"></label><label>割引率（％，指定する場合）<input name="percent" type="number" min="1" max="99"></label><label>全体の利用回数上限（任意）<input name="useLimit" type="number" min="1"></label><label>1人あたり利用回数（任意）<input name="accountLimit" type="number" min="1"></label><label>累計値引き上限（円，任意）<input name="budgetJpy" type="number" min="1"></label><label>撮影枚数<input name="photos" type="number" min="1"></label><label class="check"><input type="checkbox" name="costConfirmed">対象商品の原価・送料を確認済み（撮影協力者用）</label><button>コードを発行する</button></form>
          <div id="shop-coupon-list"></div>
          <h3>ESSEN発送担当者</h3>
          <form id="shop-staff-form" class="panel"><label>担当者メール<input name="email" type="email" required></label><div class="row"><button name="action" value="save">追加する</button><button name="action" value="remove">停止する</button></div></form>
          <div id="shop-staff-list"></div>
        </details>
        <details><summary>珈琲定期便の申込一覧</summary><p class="small">定期便の契約と請求予定はこのサイトで管理します．支払済みの注文・発送はSquareで確認します．このボタンは状況の照合だけを行い，新しい請求は実行しません．</p><p id="admin-coffee-status" role="status"></p><button id="admin-coffee-refresh" type="button">定期便の状況を照合する</button><div id="admin-coffee"></div></details>
        <form id="hsap-import-form"><label>HSAP台帳の確認済みスナップショット（JSON）<textarea name="snapshot" required spellcheck="false" placeholder='{"rows":[{"hsapId":"HSAP-000001","displayName":"表示名","email":"登録済み個人メール","workspaceEmail":"確定Workspaceメールまたはnull","status":"承認済","departedAt":null}]}'></textarea></label><button>取り込み内容を確認</button></form><pre id="hsap-preview"></pre><label class="check"><input id="hsap-emails-verified" type="checkbox">入力したメールが，それぞれの会員本人のものであることを確認しました</label><button id="hsap-import-commit" type="button" hidden>確認した台帳を取り込む</button>
      </details>
      <div class="admin-grid"><div><form id="search-form" class="search"><label for="search">表示名・メール・HSAP IDを検索</label><div class="row"><input id="search" type="search" maxlength="100"><button>検索</button></div></form><div id="member-list"></div><button id="next" hidden>次の50件</button>
        <details id="create-section" class="panel"><summary>会員を登録する</summary><form id="create-form"><label>表示名<input name="displayName" required maxlength="100"></label><label>本人確認用メール<input name="email" type="email" required></label><label>HSAP ID（該当者のみ）<input name="hsapId" pattern="HSAP-[0-9]{6}" placeholder="HSAP-000001"></label><p class="small">本人がこのメールでログインすると，初回に会員情報が紐付きます．共有アドレスは使用しないでください．</p><button>登録する</button></form></details>
      </div><div id="member-detail" class="panel" hidden><h3 id="detail-title"></h3><p id="detail-meta" class="small"></p><div id="detail-grants"></div><div id="detail-billing"></div>
        <div id="manager-actions"><details><summary>会員資格を追加する</summary><form id="grant-form"><label>資格の種類<select name="kind"><option value="HSAP">HSAP</option><option value="MONTHLY">HackSick月額会員</option></select></label><label>開始日時（日本時間）<input name="validFrom" type="datetime-local" required></label><label>終了日時（日本時間，月額会員は必須）<input name="validUntil" type="datetime-local"></label><label>根拠となるHSAP ID，またはSquare Payment ID<input name="evidenceId" required maxlength="255"></label><label>確認内容<textarea name="reason" required maxlength="1000"></textarea></label><label class="check"><input type="checkbox" required>HSAPの在籍，または入金と対象期間を確認しました</label><button>資格を追加する</button></form></details>
        <details><summary>照合済みのSquare契約を登録する</summary><form id="billing-form"><label>Square Customer ID<input name="customerId" required maxlength="255"></label><label>Square Subscription ID<input name="subscriptionId" required maxlength="255"></label><label class="check"><input type="checkbox" required>この会員本人の契約であることを確認しました</label><button>契約を登録する</button></form></details>
        <details><summary>会員の利用状態を変更する</summary><form id="status-form"><label>利用状態<select name="status"><option value="active">利用可</option><option value="blocked">利用停止</option></select></label><label>変更理由<textarea name="reason" required maxlength="1000"></textarea></label><button>変更する</button></form></details></div>
        <details><summary>変更履歴</summary><div id="history"></div></details>
      </div></div>
`;
