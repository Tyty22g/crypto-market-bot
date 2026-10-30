const $ = id => document.getElementById(id);
function apiBase(){ return $("workerUrl").value.trim().replace(/\/+$/,""); }
function headers(){ return { "content-type":"application/json", "authorization":"Bearer "+$("adminKey").value.trim() }; }
function notice(message, type="ok"){ $("notice").textContent=message; $("notice").className=type; }
async function api(path, options={}){
  if(!apiBase() || !$("adminKey").value.trim()) throw new Error("أدخل رابط Worker ومفتاح ADMIN_KEY.");
  const response=await fetch(apiBase()+path,{...options,headers:{...headers(),...(options.headers||{})}});
  const data=await response.json();
  if(!response.ok || !data.ok) throw new Error(data.error || "فشل الاتصال");
  return data;
}
function readSymbols(){
  return [...new Set($("symbols").value.split(/[\n,،\s]+/).map(x=>x.trim().toUpperCase()).filter(Boolean))];
}
function showState(data){
  const s=data.state || {};
  const line=(name,x)=> x ? `${name}: #${x.message_id} · ${x.published_at}` : `${name}: —`;
  $("status").innerHTML =
    `${line("الأسعار",s.price)}<br>${line("تحليل الساعة",s.hourly)}<br>${line("تقرير 4 ساعات",s.four_hour)}<br>` +
    `عدد الأزواج: ${(data.config?.symbols || []).length}` +
    (s.last_error ? `<br>⚠️ آخر خطأ (${s.last_error.job}): ${s.last_error.message} · ${s.last_error.at}` : "");
}
$("loadBtn").addEventListener("click", async()=>{
  try{
    const data=await api("/api/config");
    $("title").value=data.config.title || "CRYPTO MARKET";
    $("symbols").value=(data.config.symbols || []).join("\n");
    $("showHighLow").checked=data.config.showHighLow !== false;
    $("showVolume").checked=data.config.showVolume !== false;
    $("priceEveryMinutes").value=String(data.config.priceEveryMinutes || 5);
    showState(data); notice("تم تحميل الإعدادات بنجاح.");
  }catch(e){notice(e.message,"err");}
});
$("saveBtn").addEventListener("click", async()=>{
  try{
    const data=await api("/api/config",{method:"POST",body:JSON.stringify({
      title:$("title").value.trim(),
      symbols:readSymbols(),
      showHighLow:$("showHighLow").checked,
      showVolume:$("showVolume").checked,
      priceEveryMinutes:Number($("priceEveryMinutes").value)
    })});
    notice(`تم حفظ ${data.config.symbols.length} زوج تداول. اضغط نشر / تحديث الآن لتطبيق التغيير فوراً.`);
  }catch(e){notice(e.message,"err");}
});
$("publishBtn").addEventListener("click", async()=>{
  const button=$("publishBtn"); button.disabled=true;
  try{
    const data=await api("/api/publish",{method:"POST",body:"{}"});
    $("status").textContent=`تم النشر/التحديث بنجاح. رقم المنشور: ${data.message_id} · عدد الأزواج: ${data.count} · ${data.updated_at}`;
    notice("تم إرسال الأسعار إلى القناة بنجاح.");
  }catch(e){notice(e.message,"err");}
  finally{button.disabled=false;}
});
