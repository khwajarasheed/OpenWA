export const dashboardHtml = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenWA</title>
<style>
:root{font-family:Inter,system-ui,sans-serif;color:#18201b;background:#f5f7f5}*{box-sizing:border-box}body{margin:0}.shell{max-width:1080px;margin:auto;padding:32px 20px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}h1{font-size:26px;margin:0}h2{margin:0 0 8px;font-size:19px}h3{margin:0 0 6px;font-size:16px}.badge{background:#e8eee9;color:#425149;border-radius:99px;padding:6px 10px;font-size:13px}.badge.ok{background:#dbf7e6;color:#115c32}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;margin-bottom:16px}.card{background:white;border:1px solid #e1e7e1;border-radius:14px;padding:20px;margin-bottom:16px;box-shadow:0 2px 5px #00000008}.auth{max-width:460px;margin:70px auto}.muted{color:#5d6a61;line-height:1.5}.help{display:block;margin-top:4px;color:#68766d;font-size:12px;font-weight:400}.setup-list{margin:12px 0 0;padding-left:21px;color:#5d6a61}.setup-list li{margin:8px 0;line-height:1.45}.step{display:flex;gap:12px;padding:18px 0;border-top:1px solid #e8ede8}.step:first-of-type{border-top:0}.step>div{width:100%}.number{min-width:28px;height:28px;background:#176b3a;color:white;border-radius:50%;display:grid;place-items:center;font-weight:700}.saved{padding:11px 13px;border-radius:9px;background:#eef8f1;color:#25533a}.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}label{display:block;font-size:13px;font-weight:650;margin:13px 0 5px}input,select{width:100%;padding:11px;border:1px solid #bcc8bf;border-radius:8px;background:white;font:inherit}button{margin-top:16px;background:#176b3a;color:white;border:0;border-radius:8px;padding:11px 15px;font:inherit;font-weight:700;cursor:pointer}button:hover{filter:brightness(.96)}button:disabled{cursor:not-allowed;opacity:.55}button.secondary{background:white;color:#345044;border:1px solid #bcc8bf}.copy{margin:0 0 0 7px;padding:5px 8px;background:white;color:#345044;border:1px solid #bcc8bf;font-size:12px}.error{color:#a51d2d}.success{color:#176b3a}.hidden{display:none!important}code{font-size:12px;word-break:break-all;background:#eff3ef;padding:3px 5px;border-radius:4px}a{color:#176b3a}details{margin-top:12px}summary{cursor:pointer;color:#4f6257;font-size:13px}.top-actions{display:flex;gap:8px}.top-actions button{margin:0}@media(max-width:620px){header{align-items:flex-start;gap:16px}.step{align-items:flex-start}.copy{display:block;margin:8px 0 0}.top-actions{flex-direction:column}}
</style>
</head>
<body>
<main class="shell">
<header><div><h1>OpenWA</h1><p class="muted">Your customer-owned WhatsApp Business platform</p></div><span id="status" class="badge">Starting…</span></header>

<section id="fatal" class="card auth hidden"><h2>OpenWA could not start</h2><p id="fatal-message" class="error"></p><button id="retry-start">Try again</button></section>

<section id="owner-setup" class="card auth hidden">
  <h2>Create the owner account</h2>
  <p class="muted">This installation has no owner yet. The first person to finish this one-time step becomes its owner. Your password is strengthened in this browser and never sent to the Worker.</p>
  <form id="setup-form">
    <label for="owner-email">Owner email</label><input id="owner-email" required name="email" type="email" autocomplete="email">
    <label for="owner-password">Create password</label><input id="owner-password" required minlength="12" maxlength="128" name="password" type="password" autocomplete="new-password">
    <label for="owner-password-confirm">Confirm password</label><input id="owner-password-confirm" required minlength="12" maxlength="128" name="confirm_password" type="password" autocomplete="new-password">
    <button>Create owner and continue</button><p id="setup-message" class="muted" aria-live="polite"></p>
  </form>
</section>

<section id="login" class="card auth hidden">
  <h2>Sign in to OpenWA</h2>
  <p class="muted">Enter the owner password created when this installation was first opened.</p>
  <form id="login-form">
    <label for="login-password">Password</label><input id="login-password" required name="password" type="password" autocomplete="current-password">
    <button>Sign in</button><p id="login-message" class="muted" aria-live="polite"></p>
  </form>
</section>

<section id="app" class="hidden">
  <div id="overview" class="grid"></div>

  <section id="connected" class="card hidden">
    <h2>WhatsApp is connected</h2>
    <p id="connected-detail" class="muted"></p>
    <button id="manage-connection" class="secondary">Manage connection</button>
  </section>

  <section id="onboarding" class="card hidden">
    <div class="top-actions"><div><h2 id="connection-title">Connect WhatsApp</h2><p class="muted">OpenWA talks directly to Meta. Credentials are encrypted inside this Cloudflare account.</p></div></div>

    <div id="prepare-step" class="step"><span class="number">1</span><div>
      <h3>Prepare the Meta account and number</h3>
      <ol class="setup-list">
        <li>In <a href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">Meta for Developers</a>, create or select a Business app and add the WhatsApp product.</li>
        <li>Under WhatsApp → Getting Started, add the business phone number. Meta creates or links its WhatsApp Business Account.</li>
        <li>For an ongoing connection, open <a href="https://business.facebook.com/settings/" target="_blank" rel="noreferrer">Business settings</a> → Users → System users, assign the app and WhatsApp account, then generate a token with <code>whatsapp_business_management</code> and <code>whatsapp_business_messaging</code>.</li>
      </ol>
      <p class="muted">For a quick test, Meta's temporary token from WhatsApp → Getting Started also works, but it expires. The fields below show where to find the other two values.</p>
    </div></div>

    <div class="step"><span class="number">2</span><div>
      <h3>Verify the Meta webhook</h3>
      <p class="muted">In the Meta App Dashboard, open WhatsApp → Configuration and add these values:</p>
      <p class="muted">Callback URL: <code id="webhook-url"></code><button type="button" class="copy" data-copy="webhook-url">Copy</button></p>
      <p class="muted">Verification token: <code id="webhook-token"></code><button type="button" class="copy" data-copy="webhook-token">Copy</button></p>
      <p class="muted">Save the callback and select the <code>messages</code> webhook field.</p>
      <p id="webhook-state" class="muted" aria-live="polite">Waiting for Meta to verify this endpoint…</p>
    </div></div>

    <div class="step"><span class="number">3</span><div>
      <h3>Find and connect the number</h3>
      <form id="connection-form">
        <label for="waba-id">WhatsApp Business Account ID<span class="help">Business settings → Accounts → WhatsApp accounts → select the account.</span></label>
        <input required id="waba-id" name="waba_id" inputmode="numeric" pattern="[0-9]{3,30}" placeholder="e.g. 123456789">

        <label for="access-token">System-user access token<span class="help">Use a permanent system-user token, not the temporary getting-started token.</span></label>
        <input required id="access-token" name="access_token" type="password" autocomplete="off">

        <label for="app-secret">Meta app secret<span class="help">Meta App Dashboard → App settings → Basic. OpenWA uses it to validate the connection and verify signed webhooks.</span></label>
        <input required id="app-secret" name="app_secret" type="password" autocomplete="off">
        <p id="find-message" class="muted" aria-live="polite"></p>

        <div id="phone-choice" class="hidden">
          <label for="phone-number">WhatsApp phone number<span class="help">OpenWA found these numbers in the selected WABA.</span></label>
          <select id="phone-number" name="phone_number_id"></select>
        </div>

        <details><summary>Cannot list the number? Enter its Phone Number ID manually</summary>
          <label for="manual-phone-number">Phone Number ID</label><input id="manual-phone-number" name="manual_phone_number_id" inputmode="numeric" pattern="[0-9]{3,30}">
        </details>

        <div class="actions"><button id="connection-action" disabled>Find and connect my number</button><button id="cancel-settings" type="button" class="secondary hidden">Cancel</button></div>
        <p id="form-message" class="muted" aria-live="polite"></p>
      </form>
      <div id="saved-connection" class="saved hidden"></div>
    </div></div>

  </section>

  <section id="api-access" class="card hidden">
    <h2>API access</h2>
    <p class="muted">Create a full-access token for an application that will call this CORE API. The token is displayed only once.</p>
    <button id="create-api-token">Create API token</button>
    <p id="token-result" class="muted hidden">Token: <code id="api-token"></code><button type="button" class="copy" data-copy="api-token">Copy</button></p>
    <p id="token-message" class="muted"></p>
  </section>
  <button id="logout" class="secondary">Sign out</button>
</section>
</main>

<script>
const byId=id=>document.getElementById(id);
const show=(id,on)=>byId(id).classList.toggle('hidden',!on);
const message=(id,text,isError=false)=>{const node=byId(id);node.textContent=text;node.className=isError?'error':'success'};
const api=async(path,options={})=>{const response=await fetch(path,{...options,headers:{'content-type':'application/json',...(options.headers||{})}});const body=await response.json().catch(()=>({}));if(!response.ok){const reason=new Error(body.error?.message||'Request failed');reason.status=response.status;throw reason}return body};
const passwordIterations=600000;
const toBase64Url=bytes=>{let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')};
const fromBase64Url=value=>{const padded=value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4);return Uint8Array.from(atob(padded),character=>character.charCodeAt(0))};
const derivePasswordVerifier=async(password,salt,iterations)=>{const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations},material,256);return toBase64Url(new Uint8Array(bits))};
let connectionPoll;
let currentState;
let manageConnection=false;

function stopPolling(){if(connectionPoll){clearInterval(connectionPoll);connectionPoll=undefined}}
function authView(view){show('fatal',false);show('owner-setup',view==='setup');show('login',view==='login');show('app',view==='app');byId('status').textContent=view==='setup'?'First-time setup':view==='login'?'Sign in':'Loading…';if(view!=='app')stopPolling()}
function fatalView(text){stopPolling();show('owner-setup',false);show('login',false);show('app',false);show('fatal',true);byId('fatal-message').textContent=text;byId('status').textContent='Needs attention'}

async function start(){try{const bootstrap=await api('/v1/dashboard/bootstrap');if(!bootstrap.initialized){authView('setup');return}await loadApp()}catch(error){fatalView(error.message||'Check the Cloudflare deployment logs and try again.')}}

function updateConnectionAvailability(){const webhookReady=Boolean(currentState?.webhook_endpoint_verified_at||currentState?.connection?.status==='connected');byId('connection-action').disabled=!webhookReady}
function setExistingPhone(connection){if(!connection)return;byId('waba-id').value=connection.waba_id;const selector=byId('phone-number');selector.replaceChildren();const option=document.createElement('option');option.value=connection.phone_number_id;option.textContent=connection.display_phone_number||connection.phone_number_id;selector.append(option);show('phone-choice',true);updateConnectionAvailability()}

function renderConnection(state){const connection=state.connection;const connected=connection?.status==='connected';const waiting=connection?.status==='validated';const showSettings=connected&&manageConnection;const webhookReady=Boolean(state.webhook_endpoint_verified_at||connected);show('connected',connected&&!showSettings);show('onboarding',!connected||showSettings);show('api-access',connected);show('prepare-step',!showSettings);show('connection-form',!waiting||manageConnection);show('cancel-settings',showSettings);byId('connection-title').textContent=showSettings?'WhatsApp connection settings':'Connect WhatsApp';byId('connection-action').textContent=showSettings?'Save connection':'Find and connect my number';byId('webhook-state').textContent=webhookReady?'Webhook verified. Continue to connect the number.':'Waiting for Meta to verify this endpoint…';byId('webhook-state').className=webhookReady?'success':'muted';if(connection)setExistingPhone(connection);show('saved-connection',waiting&&!manageConnection);if(waiting&&!manageConnection)byId('saved-connection').textContent='Credentials are saved. Finish webhook verification above; this page will update automatically.';if(connected)byId('connected-detail').textContent='Phone number '+(connection.display_phone_number||connection.phone_number_id)+' is ready.';updateConnectionAvailability()}

async function loadApp(){try{const state=await api('/v1/dashboard/state');currentState=state;authView('app');const connected=state.connection?.status==='connected';const badge=byId('status');badge.textContent=connected?'Connected':state.connection?.status==='validated'?'Waiting for Meta':'Setup required';badge.className=connected?'badge ok':'badge';byId('webhook-url').textContent=location.origin+'/webhooks/meta';byId('webhook-token').textContent=state.webhook_verify_token||'Available to the owner';const overview=byId('overview');overview.replaceChildren();const welcome=document.createElement('article');welcome.className='card';const title=document.createElement('h2');title.textContent='Welcome'+(state.user.email?' '+state.user.email:'');const role=document.createElement('p');role.className='muted';role.textContent='Role: '+state.user.role;welcome.append(title,role);const ownership=document.createElement('article');ownership.className='card';ownership.innerHTML='<h2>Data ownership</h2><p class="muted">Messages and connection data are stored in your Cloudflare account.</p>';overview.append(welcome,ownership);renderConnection(state);stopPolling();if(!connected&&!state.webhook_endpoint_verified_at)connectionPoll=setInterval(()=>loadApp().catch(()=>{}),5000)}catch(error){if(error.status===401)authView('login');else fatalView(error.message)}}

function resetDiscoveredNumbers(){byId('phone-number').replaceChildren();show('phone-choice',false);byId('connection-action').textContent='Find and connect my number';updateConnectionAvailability();message('find-message','')}
function clearSecretFields(){byId('access-token').value='';byId('connection-form').elements.app_secret.value=''}

byId('setup-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;const data=Object.fromEntries(new FormData(form));if(data.password!==data.confirm_password){message('setup-message','Passwords do not match.',true);return}message('setup-message','Securing the password in this browser…');try{const saltBytes=crypto.getRandomValues(new Uint8Array(16));const verifier=await derivePasswordVerifier(data.password,saltBytes,passwordIterations);await api('/v1/dashboard/setup',{method:'POST',body:JSON.stringify({email:data.email,password_verifier:verifier,password_salt:toBase64Url(saltBytes),password_iterations:passwordIterations})});form.reset();await loadApp()}catch(error){message('setup-message',error.message,true)}});
byId('login-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;const data=Object.fromEntries(new FormData(form));message('login-message','Verifying securely…');try{const parameters=await api('/v1/dashboard/login-parameters');const verifier=await derivePasswordVerifier(data.password,fromBase64Url(parameters.salt),parameters.iterations);await api('/v1/dashboard/login',{method:'POST',body:JSON.stringify({password_verifier:verifier})});form.reset();await loadApp()}catch(error){message('login-message',error.message,true)}});
byId('retry-start').addEventListener('click',start);
byId('waba-id').addEventListener('input',resetDiscoveredNumbers);
byId('manual-phone-number').addEventListener('input',()=>{if(byId('manual-phone-number').value)byId('connection-action').textContent='Connect this number'});

async function saveConnection(form){const data=Object.fromEntries(new FormData(form));data.phone_number_id=data.manual_phone_number_id||data.phone_number_id;delete data.manual_phone_number_id;if(!data.phone_number_id)return false;message('form-message','Validating with Meta and completing the subscription…');byId('connection-action').disabled=true;try{const saved=await api('/v1/dashboard/connection',{method:'PUT',body:JSON.stringify(data)});manageConnection=false;clearSecretFields();message('form-message',saved.status==='connected'?'WhatsApp connected.':'Connection saved.');await loadApp();return true}catch(error){message('form-message',error.message,true);return false}finally{updateConnectionAvailability()}}

byId('connection-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;const wabaId=form.elements.waba_id.value.trim();const accessToken=form.elements.access_token.value.trim();const appSecret=form.elements.app_secret.value.trim();if(!/^\\d{3,30}$/.test(wabaId)||!accessToken||!appSecret){message('find-message','Enter the WABA ID, system-user token, and app secret first.',true);return}if(form.elements.manual_phone_number_id.value||form.elements.phone_number_id.value){await saveConnection(form);return}message('find-message','Checking Meta and finding your number…');byId('connection-action').disabled=true;try{const result=await api('/v1/dashboard/phone-numbers',{method:'POST',body:JSON.stringify({waba_id:wabaId,access_token:accessToken,app_secret:appSecret})});const selector=byId('phone-number');selector.replaceChildren();for(const phone of result.phone_numbers){const option=document.createElement('option');option.value=phone.id;option.textContent=(phone.display_phone_number||phone.id)+(phone.verified_name?' — '+phone.verified_name:'');selector.append(option)}if(!result.phone_numbers.length){resetDiscoveredNumbers();message('find-message','Meta returned no phone numbers for this WABA.',true);return}byId('manual-phone-number').value='';show('phone-choice',true);if(result.phone_numbers.length===1){message('find-message','Number found. Connecting it now…');await saveConnection(form);return}byId('connection-action').textContent='Connect selected number';message('find-message',result.phone_numbers.length+' phone numbers found. Choose one, then connect.')}catch(error){resetDiscoveredNumbers();message('find-message',error.message,true)}finally{updateConnectionAvailability()}});

byId('manage-connection').addEventListener('click',()=>{manageConnection=true;renderConnection(currentState);window.scrollTo({top:byId('onboarding').offsetTop-20,behavior:'smooth'})});
byId('cancel-settings').addEventListener('click',()=>{manageConnection=false;clearSecretFields();renderConnection(currentState)});
byId('create-api-token').addEventListener('click',async()=>{message('token-message','Creating token…');try{const result=await api('/v1/dashboard/api-tokens',{method:'POST',body:'{}'});byId('api-token').textContent=result.token;show('token-result',true);message('token-message','Copy and save this token now. OpenWA cannot show it again.')}catch(error){message('token-message',error.message,true)}});
byId('logout').addEventListener('click',async()=>{clearSecretFields();await api('/v1/dashboard/logout',{method:'POST'});authView('login')});
document.querySelectorAll('[data-copy]').forEach(button=>button.addEventListener('click',async()=>{const value=byId(button.dataset.copy).textContent;try{await navigator.clipboard.writeText(value);const label=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=label,1200)}catch{button.textContent='Select and copy'}}));
start();
</script>
</body>
</html>`;
