export const adminPanel = String.raw`
      <div class="ops-layout">
        <nav class="ops-nav" aria-label="運営メニュー">
          <a data-ops-link="orders" href="/operations?view=orders">注文・発送</a>
          <a data-ops-link="products" href="/operations?view=products">商品・在庫</a>
          <a data-ops-link="coupons" href="/operations?view=coupons">クーポン</a>
          <a data-ops-link="coffee" href="/operations?view=coffee">珈琲の定期便</a>
          <a data-ops-link="members" href="/operations?view=members">会員管理</a>
          <a data-ops-link="lt" href="/operations?view=lt">LT会の受付</a>
          <a data-ops-link="connections" href="/operations?view=connections">連携設定</a>
        </nav>
        <div class="ops-content">
          <p id="shop-rules-message" role="status"></p>
          <section class="ops-view" data-ops-view="orders" hidden aria-labelledby="ops-orders-title">
            <div class="ops-heading">
              <h2 id="ops-orders-title">注文・発送</h2>
              <button id="admin-orders-refresh" class="ops-secondary" type="button">決済・通知を照合する</button>
            </div>
            <div class="ops-summary" id="ops-order-summary" aria-label="表示対象の注文状況"></div>
            <div class="ops-filters">
              <label>注文を検索<input id="admin-order-query" type="search" maxlength="100" placeholder="受付番号・Square注文ID・商品名"></label>
              <label>発送状況<select id="admin-order-filter">
                <option value="all">すべて</option><option value="pending">発送待ち</option><option value="held">発送保留</option>
                <option value="review">決済確認中</option><option value="shipped">発送済み</option>
              </select></label>
            </div>
            <p id="admin-orders-status" role="status" class="small"></p>
            <p class="small">独自ショップと会員ショップの注文を最大100件表示します．旧Square Onlineの注文はSquareで確認してください．</p>
            <div id="admin-orders"></div>
          </section>
          <section class="ops-view" data-ops-view="products" hidden aria-labelledby="ops-products-title">
            <h2 id="ops-products-title">商品・在庫</h2>
            <p id="stock-status" role="status"></p>
            <div id="admin-stock" class="ops-stock" aria-label="Squareの共通在庫"></div>
            <h3>商品の販売設定</h3>
            <div id="shop-product-list"></div>
            <form id="shop-product-form" class="panel ops-editor">
              <div class="address-grid">
                <label>SKU<input name="sku" required></label>
                <label>Square商品ID<input name="squareItemId" required></label>
                <label>商品名<input name="name" required maxlength="120"></label>
                <label>説明<textarea name="description" required maxlength="2000"></textarea></label>
                <label>税込価格（円）<input name="unitPriceJpy" type="number" min="1" required></label>
                <label>珈琲袋数（その他は0）<input name="bags" type="number" min="0" value="0" required></label>
                <label>対象ステータス（空欄は通常販売）<input name="requiredStatus"></label>
                <label>発送元<select name="fulfillmentSource"><option value="hacksick">HackSick</option><option value="essen">ESSEN</option></select></label>
                <label>商品写真（500KB以内）<input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label>
              </div>
              <button>商品を保存する</button>
            </form>
            <h3>会員の販売ステータス</h3>
            <div id="shop-status-list"></div>
            <form id="shop-status-form" class="panel"><label>会員ID<input name="memberId" required></label>
                <label>ステータス（半角英小文字・数字・ハイフン）<input name="status" required pattern="[a-z0-9_-]{1,40}"></label>
                <label>有効期限（任意）<input name="expiresAt" type="datetime-local"></label><div class="row"><button name="action" value="save">付与する</button><button name="action" value="remove">解除する</button></div></form>
          </section>
          <section class="ops-view" data-ops-view="coupons" hidden aria-labelledby="ops-coupons-title">
            <h2 id="ops-coupons-title">クーポン</h2>
            <form id="shop-coupon-form" class="panel ops-editor coupon-editor">
              <h3>クーポンを発行する</h3>
              <div class="address-grid">
                <label>種類
                  <select name="template">
                    <option value="lt">LT参加者・10％</option>
                    <option value="supporter">イベント協力者・20％</option>
                    <option value="photographer">撮影協力者・50％</option>
                    <option value="custom">割引率を指定</option>
                  </select>
                </label>
                <label>クーポン名<input name="label" required maxlength="80" placeholder="例　LT会参加特典"></label>
              </div>
              <div class="address-grid">
                <label data-coupon-templates="custom" hidden>割引率（％）<input name="percent" type="number" min="1" max="99" required disabled></label>
                <label data-coupon-templates="photographer" hidden>撮影枚数<input name="photos" type="number" min="1" max="1000" required disabled></label>
              </div>
              <label class="check" data-coupon-templates="photographer" hidden>
                <input type="checkbox" name="costConfirmed" required disabled>対象商品の原価・送料を確認済み
              </label>
              <fieldset class="coupon-section">
                <legend>使える人</legend>
                <div class="coupon-audience">
                  <label class="check"><input type="radio" name="audience" value="shared" checked>共通コード</label>
                  <label class="check"><input type="radio" name="audience" value="personal">1人に限定</label>
                </div>
                <p class="small" id="coupon-audience-help">共通コードは，条件を満たすログイン済みの購入者が使えます．</p>
                <div id="coupon-personal" hidden>
                  <label for="coupon-recipient-search">利用者を検索</label>
                  <div class="row">
                    <input id="coupon-recipient-search" type="search" maxlength="100" placeholder="名前・メールアドレス・HSAP ID">
                    <button id="coupon-search-recipient" class="ops-secondary" type="button">検索</button>
                  </div>
                  <p id="coupon-recipient-status" class="small" role="status"></p>
                  <div id="coupon-recipient-results" class="coupon-options"></div>
                  <label>利用者のログイン用メールアドレス<input name="email" type="email" maxlength="254" disabled></label>
                  <p class="small">検索結果から選ぶか，直接入力できます．このアドレスで本人確認したアカウントで使えます．</p>
                </div>
              </fieldset>
              <fieldset class="coupon-section">
                <legend>対象商品</legend>
                <p class="small">選んだ商品の単発購入に適用します．数量の下限はありません．カテゴリは商品を探すための絞り込みです．</p>
                <div class="address-grid">
                  <label>商品を検索<input id="coupon-product-query" type="search" maxlength="100" placeholder="商品名・SKU"></label>
                  <label>表示するカテゴリ<select id="coupon-product-category"><option value="">すべて</option></select></label>
                </div>
                <div id="coupon-product-options" class="coupon-options">対象商品の一覧を読み込んでいます．</div>
                <p id="coupon-products-selected" class="small" role="status"></p>
              </fieldset>
              <label for="coupon-member-mode">会員割引との併用</label>
              <select id="coupon-member-mode" name="memberDiscountMode">
                <option value="best">割引額が大きい方を使う</option>
                <option value="stack">会員割引と併用する</option>
              </select>
              <p class="small">併用する場合は，会員割引を引いた後の対象商品代金にクーポンを適用します．</p>
              <details class="coupon-more">
                <summary>コード・期限・利用上限を指定する</summary>
                <div class="address-grid">
                  <label>コード（空欄は自動生成）<input name="code" maxlength="64"></label>
                  <label>有効期限（日本時間）<input name="expiresAt" type="datetime-local"></label>
                  <label>全体の利用回数上限<input name="useLimit" type="number" min="1" max="100000"></label>
                  <label data-coupon-templates="custom photographer">1人あたりの利用回数上限<input name="accountLimit" type="number" min="1" max="10000000"></label>
                  <label data-coupon-templates="lt custom">累計値引き上限（円）<input name="budgetJpy" type="number" min="1" max="10000000"></label>
                </div>
              </details>
              <p id="coupon-preview" class="coupon-preview" role="status"></p>
              <p id="coupon-issue-status" role="status"></p>
              <button id="coupon-issue" type="submit" disabled>コードを発行する</button>
              <div id="coupon-issued" class="coupon-preview" hidden>
                <label>発行したコード<input id="coupon-issued-code" readonly></label>
                <button id="coupon-copy-code" class="ops-secondary" type="button">コードをコピー</button>
              </div>
            </form>
            <h3>発行済みクーポン</h3>
            <div id="shop-coupon-list"></div>
          </section>
          <section class="ops-view" data-ops-view="coffee" hidden aria-labelledby="ops-coffee-title">
            <div class="ops-heading"><h2 id="ops-coffee-title">珈琲の定期便</h2><button id="admin-coffee-refresh" class="ops-secondary" type="button">申込・支払いを照合する</button></div>
            <p id="admin-coffee-status" role="status"></p>
            <div id="admin-coffee"></div>
          </section>
          <section class="ops-view" data-ops-view="connections" hidden aria-labelledby="ops-connections-title">
            <h2 id="ops-connections-title">連携設定</h2>
            <div class="panel ops-setting">
              <h3>Square</h3><p id="square-connection-status" role="status"></p><button id="square-connect" type="button">Squareと接続する</button>
            </div>
            <div class="panel ops-setting">
              <h3>月額会員の入金照合</h3><button id="billing-sync" type="button">照合する</button><p id="billing-sync-status" role="status" class="small"></p>
            </div>
            <h3>ESSEN発送担当者</h3>
            <div id="shop-staff-list"></div>
            <form id="shop-staff-form" class="panel"><label>担当者メール<input name="email" type="email" required></label><div class="row"><button name="action" value="save">追加する</button><button name="action" value="remove">停止する</button></div></form>
          </section>
      <section id="lt-check-in" class="ops-view" data-ops-view="lt" hidden aria-labelledby="lt-check-in-title">
        <h2 id="lt-check-in-title">LT会の受付</h2>
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

          <section class="ops-view" data-ops-view="members" hidden aria-labelledby="ops-members-title">
            <h2 id="ops-members-title">会員管理</h2>
      <div class="admin-grid"><div><form id="search-form" class="search"><label for="search">表示名・メール・HSAP IDを検索</label><div class="row"><input id="search" type="search" maxlength="100"><button>検索</button></div></form><div id="member-list"></div><button id="next" hidden>次の50件</button>
        <details id="create-section" class="panel"><summary>会員を登録する</summary><form id="create-form"><label>表示名<input name="displayName" required maxlength="100"></label><label>本人確認用メール<input name="email" type="email" required></label><label>HSAP ID（該当者のみ）<input name="hsapId" pattern="HSAP-[0-9]{6}" placeholder="HSAP-000001"></label><p class="small">本人がこのメールでログインすると，初回に会員情報が紐付きます．共有アドレスは使用しないでください．</p><button>登録する</button></form></details>
      </div><div id="member-detail" class="panel" hidden><h3 id="detail-title"></h3><p id="detail-meta" class="small"></p><div id="detail-grants"></div><div id="detail-billing"></div>
        <div id="manager-actions"><details><summary>会員資格を追加する</summary><form id="grant-form"><label>資格の種類<select name="kind"><option value="HSAP">HSAP</option><option value="MONTHLY">HackSick月額会員</option></select></label><label>開始日時（日本時間）<input name="validFrom" type="datetime-local" required></label><label>終了日時（日本時間，月額会員は必須）<input name="validUntil" type="datetime-local"></label><label>根拠となるHSAP ID，またはSquare Payment ID<input name="evidenceId" required maxlength="255"></label><label>確認内容<textarea name="reason" required maxlength="1000"></textarea></label><label class="check"><input type="checkbox" required>HSAPの在籍，または入金と対象期間を確認しました</label><button>資格を追加する</button></form></details>
        <details><summary>照合済みのSquare契約を登録する</summary><form id="billing-form"><label>Square Customer ID<input name="customerId" required maxlength="255"></label><label>Square Subscription ID<input name="subscriptionId" required maxlength="255"></label><label class="check"><input type="checkbox" required>この会員本人の契約であることを確認しました</label><button>契約を登録する</button></form></details>
        <details><summary>会員の利用状態を変更する</summary><form id="status-form"><label>利用状態<select name="status"><option value="active">利用可</option><option value="blocked">利用停止</option></select></label><label>変更理由<textarea name="reason" required maxlength="1000"></textarea></label><button>変更する</button></form></details></div>
        <details><summary>変更履歴</summary><div id="history"></div></details>
      </div></div>

            <details id="hsap-import-section" class="panel" hidden><summary>HSAP台帳を取り込む</summary>
        <form id="hsap-import-form"><label>HSAP台帳の確認済みスナップショット（JSON）<textarea name="snapshot" required spellcheck="false" placeholder='{"rows":[{"hsapId":"HSAP-000001","displayName":"表示名","email":"登録済み個人メール","workspaceEmail":"確定Workspaceメールまたはnull","status":"承認済","departedAt":null}]}'></textarea></label><button>取り込み内容を確認</button></form><pre id="hsap-preview"></pre><label class="check"><input id="hsap-emails-verified" type="checkbox">入力したメールが，それぞれの会員本人のものであることを確認しました</label><button id="hsap-import-commit" type="button" hidden>確認した台帳を取り込む</button>
            </details>
          </section>
        </div>
      </div>
`;
