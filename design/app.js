/* Inspire Academy — Front-End Design Prototype (mock data, no backend) */
"use strict";

/* ================= MOCK DATA ================= */
const GROUPS = [
  { id:"u10", name:"Under 10", fee:4500, players:24, color:"#0EA5E9" },
  { id:"u13", name:"Under 13", fee:5000, players:31, color:"#16A34A" },
  { id:"u16", name:"Under 16", fee:5500, players:28, color:"#7C3AED" },
  { id:"u19", name:"Under 19", fee:6000, players:19, color:"#F59E0B" },
];

const PLAYERS = [
  { id:"P-1041", name:"Dineth Fernando", dob:"2014-03-12", group:"u10", status:"Active", guardian:"Nimal Fernando", phone:"+94 77 123 4455", guardian2:"Sanduni Fernando", reg:"2024-01-15", notes:"Left-footed winger.", balance:0 },
  { id:"P-1042", name:"Shenal Perera", dob:"2013-07-02", group:"u10", status:"Active", guardian:"Ruwan Perera", phone:"+94 71 882 3109", guardian2:"", reg:"2024-02-01", notes:"", balance:4500 },
  { id:"P-1077", name:"Aadhil Rahman", dob:"2011-11-25", group:"u13", status:"Active", guardian:"Faslan Rahman", phone:"+94 76 441 9021", guardian2:"", reg:"2023-06-10", notes:"Asthma — inhaler in kit bag.", balance:5000 },
  { id:"P-1089", name:"Kavindu Silva", dob:"2010-05-30", group:"u16", status:"Active", guardian:"Pradeep Silva", phone:"+94 77 990 1123", guardian2:"Nadeesha Silva", reg:"2023-03-22", notes:"Team captain.", balance:0 },
  { id:"P-1093", name:"Yohan Jayasuriya", dob:"2008-09-14", group:"u19", status:"Active", guardian:"Lalith Jayasuriya", phone:"+94 72 334 8890", guardian2:"", reg:"2022-11-05", notes:"", balance:6000 },
  { id:"P-1101", name:"Ravindu Costa", dob:"2012-01-19", group:"u13", status:"Inactive", guardian:"Mario Costa", phone:"+94 75 223 4471", guardian2:"", reg:"2024-04-12", notes:"Paused — exams until Dec.", balance:0 },
  { id:"P-1104", name:"Senuka Bandara", dob:"2015-08-08", group:"u10", status:"Active", guardian:"Kasun Bandara", phone:"+94 78 556 2098", guardian2:"", reg:"2024-09-02", notes:"New trialist, suggested U10.", balance:4500 },
  { id:"P-1110", name:"Tharusha Mendis", dob:"2009-12-01", group:"u16", status:"Withdrawn", guardian:"Gayan Mendis", phone:"+94 71 009 3345", guardian2:"", reg:"2023-08-30", notes:"Moved abroad.", balance:0 },
];

const COACHES = [
  { id:"C-01", name:"Coach Asanka", group:"u10", phone:"+94 77 201 9988", sessions:8, checkin:"16:55", status:"Checked-in" },
  { id:"C-02", name:"Coach Nuwan", group:"u13", phone:"+94 71 445 2201", sessions:8, checkin:"17:02", status:"Checked-in" },
  { id:"C-03", name:"Coach Faris", group:"u16", sessions:6, phone:"+94 76 889 1140", checkin:"—", status:"Not in" },
  { id:"C-04", name:"Coach Devinda", group:"u19", sessions:6, phone:"+94 75 332 7765", checkin:"16:48", status:"Checked-out" },
];

const SESSIONS = [
  { id:"S-231", group:"u13", title:"U13 · Tue 14 Oct · 5:00 PM", venue:"Main pitch", present:0, total:31, state:"upcoming" },
  { id:"S-230", group:"u10", title:"U10 · Tue 14 Oct · 4:00 PM", venue:"Training ground B", present:0, total:24, state:"upcoming" },
  { id:"S-229", group:"u16", title:"U16 · Thu 09 Oct · 5:00 PM", venue:"Main pitch", present:24, total:28, state:"done" },
];

const ROSTER = [
  { id:"P-1077", name:"Aadhil Rahman", st:null },
  { id:"P-1089", name:"Kavindu Silva", st:"present" },
  { id:"P-1041", name:"Dineth Fernando", st:"present" },
  { id:"P-1042", name:"Shenal Perera", st:null },
  { id:"P-1104", name:"Senuka Bandara", st:"late" },
  { id:"P-1101", name:"Ravindu Costa", st:"excused" },
];

const INVOICES = [
  { id:"INV-2026-101", player:"Aadhil Rahman", pid:"P-1077", group:"Under 13", period:"Oct 2026", amount:5000, paid:0, status:"Overdue", due:"05 Oct 2026" },
  { id:"INV-2026-102", player:"Shenal Perera", pid:"P-1042", group:"Under 10", period:"Oct 2026", amount:4500, paid:2000, status:"Partial", due:"05 Oct 2026" },
  { id:"INV-2026-103", player:"Kavindu Silva", pid:"P-1089", group:"Under 16", period:"Oct 2026", amount:5500, paid:5500, status:"Paid", due:"05 Oct 2026" },
  { id:"INV-2026-104", player:"Yohan Jayasuriya", pid:"P-1093", group:"Under 19", period:"Oct 2026", amount:6000, paid:0, status:"Issued", due:"15 Oct 2026" },
  { id:"INV-2026-105", player:"Senuka Bandara", pid:"P-1104", group:"Under 10", period:"Oct 2026", amount:4500, paid:0, status:"Issued", due:"15 Oct 2026" },
];

const MSGS = [
  { id:"M-91", to:"Faslan Rahman · +94 76 441 9021", tpl:"Overdue reminder", ref:"INV-2026-101", status:"Failed", time:"09:12 · retry available" },
  { id:"M-90", to:"Ruwan Perera · +94 71 882 3109", tpl:"Due-soon reminder", ref:"INV-2026-102", status:"Delivered", time:"09:05" },
  { id:"M-89", to:"Lalith Jayasuriya · +94 72 334 8890", tpl:"Invoice delivery", ref:"INV-2026-104", status:"Sent", time:"08:58" },
  { id:"M-88", to:"Kasun Bandara · +94 78 556 2098", tpl:"Invoice delivery", ref:"INV-2026-105", status:"Read", time:"08:41" },
];

const AUDIT = [
  { t:"10:42 · 11 Oct", who:"Owner (S. Perera)", what:"Voided INV-2026-098 · reason: duplicate run" },
  { t:"09:58 · 11 Oct", who:"Coach Nuwan", what:"Corrected attendance S-229 · P-1089 Absent → Present" },
  { t:"09:20 · 11 Oct", who:"Owner (S. Perera)", what:"Recorded cash payment Rs 2,000 → INV-2026-102" },
  { t:"17:40 · 09 Oct", who:"Owner (S. Perera)", what:"Edited U16 fee Rs 5,000 → Rs 5,500 (new invoices only)" },
];

/* ================= STATE ================= */
const state = { role:"owner", view:"dashboard", playerId:"P-1077", invoiceId:"INV-2026-101", sessionId:"S-231", playerFilter:"All", attendance:{}, coachFilter:"mine" };
ROSTER.forEach(r => state.attendance[r.id] = r.st);

/* ================= HELPERS ================= */
const $ = s => document.querySelector(s);
const view = () => $("#view");
const LKR = n => "Rs " + n.toLocaleString("en-LK");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

function icons(){ if (window.lucide) lucide.createIcons(); }
function toast(msg){
  const t = document.createElement("div");
  t.className = "bg-navy-900 text-white text-[14px] font-medium px-4 py-3 rounded-xl shadow-pop max-w-[92vw]";
  t.textContent = msg;
  $("#toasts").appendChild(t); icons();
  setTimeout(()=>{ t.style.opacity="0"; setTimeout(()=>t.remove(), 250); }, 2600);
}
function openModal(html){
  const m = $("#modal"); $("#modalCard").innerHTML = html;
  m.classList.remove("hidden"); m.classList.add("flex"); icons();
  const f = $("#modalCard").querySelector("input,select,button"); if (f) f.focus();
}
function closeModal(){ const m=$("#modal"); m.classList.add("hidden"); m.classList.remove("flex"); }
let confirmCb = null;
function askConfirm(title, text, okLabel, cb){
  $("#confirmTitle").textContent = title; $("#confirmText").textContent = text;
  $("#confirmOk").textContent = okLabel || "Confirm"; confirmCb = cb;
  const c = $("#confirm"); c.classList.remove("hidden"); c.classList.add("flex"); icons();
}

const NAV_OWNER = [
  ["dashboard","layout-dashboard","Dashboard"],["players","users","Players"],["groups","layers","Age Groups"],
  ["coaches","whistle","Coaches"],["sessions","calendar-check","Sessions"],["coachtime","timer","Coach Time"],
  ["billing","receipt","Billing"],["whatsapp","message-circle","WhatsApp"],["reports","bar-chart-3","Reports"],
  ["users","shield","Users"],["settings","settings","Settings"],["audit","history","Audit"],
];
const NAV_COACH = [
  ["dashboard","layout-dashboard","Dashboard"],["sessions","calendar-check","Sessions"],["coachtime","timer","Coach Time"],["players","users","My Players"],
];
const ICON_FALLBACK = { whistle:"user-check" };

function statusBadge(s){
  const map = {
    "Active":"bg-emerald-50 text-emerald-700 border-emerald-200","Inactive":"bg-slate-100 text-slate-600 border-slate-200",
    "Withdrawn":"bg-slate-100 text-slate-500 border-slate-200","Paid":"bg-emerald-50 text-emerald-700 border-emerald-200",
    "Partial":"bg-amber-50 text-amber-700 border-amber-200","Issued":"bg-blue-50 text-blue-700 border-blue-200",
    "Overdue":"bg-red-50 text-red-700 border-red-200","Draft":"bg-slate-100 text-slate-600 border-slate-200",
    "Void":"bg-slate-100 text-slate-500 border-slate-200","Delivered":"bg-emerald-50 text-emerald-700 border-emerald-200",
    "Read":"bg-emerald-50 text-emerald-700 border-emerald-200","Sent":"bg-blue-50 text-blue-700 border-blue-200",
    "Failed":"bg-red-50 text-red-700 border-red-200","Checked-in":"bg-emerald-50 text-emerald-700 border-emerald-200",
    "Checked-out":"bg-slate-100 text-slate-600 border-slate-200","Not in":"bg-amber-50 text-amber-700 border-amber-200",
  };
  return `<span class="inline-flex items-center gap-1 text-[12px] font-semibold border rounded-full px-2.5 py-1 ${map[s]||'bg-slate-100 text-slate-600 border-slate-200'}">${esc(s)}</span>`;
}
function sectionHead(title, sub, actions){
  return `<div class="flex flex-wrap items-end justify-between gap-3 mb-4">
    <div><h2 class="font-heading font-semibold text-[20px] sm:text-[24px] text-slate-900">${title}</h2>
    <p class="text-[13px] sm:text-[14px] text-slate-600">${sub}</p></div>
    <div class="flex flex-wrap gap-2">${actions||""}</div></div>`;
}
function btnPrimary(label, icon, attrs){
  return `<button ${attrs||""} class="btn cursor-pointer touch44 inline-flex items-center justify-center gap-2 h-11 px-4 rounded-xl bg-pitch-600 text-white text-[14px] font-semibold hover:bg-pitch-700">${icon?`<i data-lucide="${icon}" class="w-4 h-4"></i>`:""}${label}</button>`;
}
function btnGhost(label, icon, attrs){
  return `<button ${attrs||""} class="btn cursor-pointer touch44 inline-flex items-center justify-center gap-2 h-11 px-4 rounded-xl border border-slate-200 bg-white text-[14px] font-semibold text-slate-700 hover:border-pitch-600">${icon?`<i data-lucide="${icon}" class="w-4 h-4"></i>`:""}${label}</button>`;
}
function emptyState(icon, title, sub, action){
  return `<div class="bg-white border border-slate-200 rounded-2xl shadow-card p-10 text-center">
    <div class="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3"><i data-lucide="${icon}" class="w-6 h-6 text-slate-500"></i></div>
    <p class="font-heading font-semibold text-[16px]">${title}</p><p class="text-[14px] text-slate-600 mt-1">${sub}</p>
    <div class="mt-4 flex justify-center">${action||""}</div></div>`;
}
function denied(feature){
  return `<div class="bg-white border border-slate-200 rounded-2xl shadow-card p-10 text-center">
    <div class="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-3"><i data-lucide="lock" class="w-6 h-6 text-red-500"></i></div>
    <p class="font-heading font-semibold text-[17px]">Restricted — Owners only</p>
    <p class="text-[14px] text-slate-600 mt-1">Coaches can't access ${feature}. This is enforced on the server, not just hidden in the UI.</p>
    ${btnGhost("Back to Dashboard","arrow-left",'onclick="go(\'dashboard\')"')}</div>`;
}
function kpi(label, value, sub, icon, tone){
  const tones = { green:"bg-pitch-50 text-pitch-700", amber:"bg-amberx-50 text-amber-500", red:"bg-red-50 text-red-600", blue:"bg-blue-50 text-blue-600", navy:"bg-navy-900 text-white" };
  return `<div class="card-hover cursor-pointer bg-white border border-slate-200 rounded-2xl shadow-card p-4">
    <div class="flex items-center justify-between">
      <p class="text-[12px] font-semibold uppercase tracking-wide text-slate-600">${label}</p>
      <span class="w-9 h-9 rounded-lg ${tones[tone]||tones.green} flex items-center justify-center"><i data-lucide="${icon}" class="w-4 h-4"></i></span>
    </div>
    <p class="font-heading font-bold text-[24px] tabular mt-1">${value}</p>
    <p class="text-[13px] text-slate-600">${sub}</p></div>`;
}

/* ================= NAV / ROUTER ================= */
function navItems(){ return state.role === "owner" ? NAV_OWNER : NAV_COACH; }
function titles(v){
  return { dashboard:["Dashboard","Academy overview · Tue 11 Oct 2026"], players:[state.role==="owner"?"Players":"My Players","Profiles, guardians & status"],
    profile:["Player Profile","Registration, history & balances"], groups:["Age Groups","Fees, eligibility & squads"],
    coaches:["Coaches","Assignments & contact"], sessions:["Sessions & Attendance","Rosters · Tue / Thu default"],
    coachtime:["Coach Time","Check-in / check-out with audit"], billing:["Billing & Invoices","Oct 2026 · monthly plan"],
    invoice:["Invoice Detail","Items, payments & receipt"], whatsapp:["WhatsApp (OpenWA)","Reminders, delivery & retries"],
    reports:["Reports & Exports","Players · attendance · finance"], users:["Users","Owner & coach accounts"],
    settings:["Academy Settings","Billing rules, season & messaging"], audit:["Audit & Health","History & system status"] }[v] || ["Dashboard",""];
}
function go(v, arg){
  if (v==="profile" && arg) state.playerId = arg;
  if (v==="invoice" && arg) state.invoiceId = arg;
  state.view = v;
  const [t,s] = titles(v); $("#pageTitle").textContent = t; $("#pageSub").textContent = s;
  renderNav(); view().innerHTML = VIEWS[v] ? VIEWS[v]() : "";
  view().scrollTop = 0; window.scrollTo({top:0});
  icons();
}
function renderNav(){
  const items = navItems();
  $("#sideNav").innerHTML = items.map(([v,ic,label])=>`
    <button onclick="go('${v}')" aria-current="${state.view===v?'page':'false'}"
      class="navlink cursor-pointer w-full flex items-center gap-3 px-3 h-11 rounded-xl text-left font-medium ${state.view===v||(state.view==='profile'&&v==='players')||(state.view==='invoice'&&v==='billing')?'bg-white/12 bg-white/10 text-white':'text-slate-300 hover:bg-white/5 hover:text-white'}">
      <i data-lucide="${ICON_FALLBACK[ic]||ic}" class="w-5 h-5 shrink-0"></i>${label}
      ${v==='billing'?'<span class="ml-auto text-[11px] font-bold bg-red-500 text-white rounded-full px-2 py-0.5">3</span>':""}
    </button>`).join("");
  const mains = items.slice(0,4), rest = items.slice(4);
  $("#bottomNav").innerHTML = `<div class="grid grid-cols-5 px-1 pt-1" style="padding-bottom:calc(env(safe-area-inset-bottom) + 6px)">` +
    mains.map(([v,ic,label])=>`
      <button onclick="go('${v}')" class="btn cursor-pointer touch44 flex flex-col items-center justify-center gap-1 py-2 rounded-lg ${state.view===v?'text-pitch-700':'text-slate-500'}">
        <i data-lucide="${ICON_FALLBACK[ic]||ic}" class="w-5 h-5"></i><span class="text-[11px] font-semibold">${label.split(" ")[0]}</span>
      </button>`).join("") +
    `<button onclick="document.getElementById('moreSheet').classList.remove('hidden')" class="btn cursor-pointer touch44 flex flex-col items-center justify-center gap-1 py-2 rounded-lg text-slate-500">
      <i data-lucide="more-horizontal" class="w-5 h-5"></i><span class="text-[11px] font-semibold">More</span></button></div>`;
  $("#moreGrid").innerHTML = rest.map(([v,ic,label])=>`
    <button onclick="document.getElementById('moreSheet').classList.add('hidden');go('${v}')" class="btn cursor-pointer touch44 flex flex-col items-center gap-1 p-3 rounded-xl border border-slate-200 text-slate-700">
      <i data-lucide="${ICON_FALLBACK[ic]||ic}" class="w-5 h-5"></i><span class="text-[12px] font-semibold text-center">${label}</span></button>`).join("");
  const owner = state.role==="owner";
  $("#roleAvatar").textContent = owner ? "OW" : "CH";
  $("#roleName").textContent = owner ? "S. Perera · Owner" : "Coach Nuwan · U13";
  $("#rolePillText").textContent = owner ? "Owner" : "Coach";
  $("#roleSwitchSide").textContent = owner ? "Switch to Coach view" : "Switch to Owner view";
}

/* ================= VIEWS ================= */
const VIEWS = {};

/* ---- DASHBOARD ---- */
VIEWS.dashboard = function(){
  const coachOnly = state.role === "coach";
  return sectionHead("Good evening, " + (coachOnly?"Coach Nuwan":"Owner"),
    coachOnly ? "Your U13 sessions · Tue 14 Oct" : "Here's what's happening across Inspire Academy today.",
    coachOnly ? btnPrimary("Take attendance","clipboard-check",'onclick="go(\'sessions\')"')
              : btnPrimary("New invoice run","plus",'onclick="toast(\'Billing preview: 96 eligible · 0 duplicates\')"') + btnGhost("Export","download",'onclick="toast(\'CSV exported\')"'))
  + `<div class="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
      ${kpi("Active players","102","+4 this month","users","green")}
      ${kpi("Collected · Oct", LKR(312500),"of "+LKR(487500)+" invoiced","wallet","navy")}
      ${kpi("Outstanding", LKR(175000),"3 overdue · Rs 15,500","alert-circle","red")}
      ${kpi("Attendance today","87%","Tue sessions · 4 groups","calendar-check","blue")}
    </div>
    <div class="grid lg:grid-cols-3 gap-3">
      <div class="lg:col-span-2 bg-white border border-slate-200 rounded-2xl shadow-card p-5">
        <div class="flex items-center justify-between mb-1"><h3 class="font-heading font-semibold text-[16px]">Fees collected vs invoiced</h3><span class="text-[12px] font-semibold text-slate-500">LAST 6 WEEKS</span></div>
        <div class="flex items-end gap-2 h-36 mt-3" role="img" aria-label="Bar chart: collections rising over six weeks">
          ${[42,55,48,66,74,88].map((h,i)=>`<div class="flex-1 flex flex-col items-center gap-1"><div class="bar w-full rounded-t-lg ${i===5?'bg-pitch-600':'bg-slate-200'}" style="height:${h}%"></div><span class="text-[11px] text-slate-500">W${i+1}</span></div>`).join("")}
        </div>
        <p class="text-[13px] text-slate-600 mt-3">Invoiced amounts and money actually collected are tracked separately — a paid invoice moves the green number, never just the issue count.</p>
      </div>
      <div class="bg-navy-900 text-white rounded-2xl shadow-card p-5">
        <h3 class="font-heading font-semibold text-[16px]">Upcoming sessions</h3>
        <div class="mt-3 space-y-2">
          ${SESSIONS.slice(0,2).map(s=>`<div class="rounded-xl bg-white/8 bg-white/10 border border-white/10 p-3 flex items-center gap-3">
            <span class="w-10 h-10 rounded-lg bg-pitch-600 flex items-center justify-center font-heading font-bold text-[14px]">TU</span>
            <div class="min-w-0"><p class="text-[14px] font-semibold truncate">${esc(s.title)}</p><p class="text-[12px] text-slate-300">${esc(s.venue)} · roster ready</p></div>
          </div>`).join("")}
        </div>
        <button onclick="go('sessions')" class="btn cursor-pointer touch44 mt-3 w-full h-11 rounded-xl bg-white text-navy-900 text-[14px] font-semibold hover:bg-slate-100">Open sessions</button>
      </div>
    </div>
    <div class="grid lg:grid-cols-3 gap-3 mt-3">
      <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5">
        <h3 class="font-heading font-semibold text-[16px] mb-3">Invoices due soon</h3>
        <div class="space-y-2">${INVOICES.filter(i=>i.status==="Issued"||i.status==="Partial").map(i=>`
          <button onclick="go('invoice','${i.id}')" class="btn cursor-pointer w-full text-left rounded-xl border border-slate-200 p-3 hover:border-pitch-600 flex items-center justify-between gap-2">
            <span><span class="block text-[14px] font-semibold">${esc(i.player)}</span><span class="block text-[12px] text-slate-600">${i.id} · due ${esc(i.due)} · <b class="tabular">${LKR(i.amount-i.paid)}</b> left</span></span>${statusBadge(i.status)}
          </button>`).join("")}</div>
      </div>
      <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5">
        <h3 class="font-heading font-semibold text-[16px] mb-3">Today's attendance</h3>
        ${[["Under 10",82,"#0EA5E9"],["Under 13",91,"#16A34A"],["Under 16",86,"#7C3AED"],["Under 19",78,"#F59E0B"]].map(([g,p,c])=>`
          <div class="mb-3"><div class="flex justify-between text-[13px] mb-1"><span class="font-medium">${g}</span><span class="tabular font-semibold">${p}%</span></div>
          <div class="h-2 rounded-full bg-slate-100"><div class="bar h-2 rounded-full" style="width:${p}%;background:${c}"></div></div></div>`).join("")}
        <p class="text-[12px] text-slate-500">Thu 09 Oct final · Tue 14 Oct pending</p>
      </div>
      <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5 ${coachOnly?'opacity-60':''}">
        <div class="flex items-center justify-between mb-3"><h3 class="font-heading font-semibold text-[16px]">WhatsApp / OpenWA</h3><span class="w-2.5 h-2.5 rounded-full bg-emerald-500" title="connected"></span></div>
        ${coachOnly?'<p class="text-[14px] text-slate-600">Messaging controls are owner-only.</p>':`
        <div class="text-[14px] space-y-2">
          <div class="flex justify-between"><span class="text-slate-600">Delivered (7d)</span><b class="tabular">214</b></div>
          <div class="flex justify-between"><span class="text-slate-600">Failed — needs retry</span><b class="tabular text-red-600">1</b></div>
          <div class="flex justify-between"><span class="text-slate-600">Session</span><b>Connected</b></div>
        </div>
        <button onclick="go('whatsapp')" class="btn cursor-pointer touch44 mt-3 w-full h-11 rounded-xl border border-slate-200 font-semibold text-[14px] hover:border-pitch-600">Open message log</button>`}
      </div>
    </div>`;
};

/* ---- PLAYERS ---- */
VIEWS.players = function(){
  const mine = state.role === "coach";
  const list = PLAYERS.filter(p => state.playerFilter==="All" ? true : p.status===state.playerFilter)
                      .filter(p => !mine || p.group==="u13");
  return sectionHead(mine?"My players — Under 13":"Players",
    mine?"Your assigned group roster (financial data hidden).":`${PLAYERS.filter(p=>p.status==="Active").length} active · duplicate warnings on · LKR`,
    (state.role==="owner" ? btnPrimary("Register player","user-plus",'onclick="playerModal()"') : "") + btnGhost("Filters","filter",'onclick="toast(\'Filter: status, group, balance\')"'))
  + `<div class="flex gap-2 mb-3 overflow-x-auto scrollx pb-1" role="tablist" aria-label="Status filter">
      ${["All","Active","Inactive","Withdrawn"].map(f=>`<button onclick="state.playerFilter='${f}';go('players')" role="tab" aria-selected="${state.playerFilter===f}"
        class="btn cursor-pointer touch44 shrink-0 h-10 px-4 rounded-full text-[13px] font-semibold border ${state.playerFilter===f?'bg-navy-900 text-white border-navy-900':'bg-white text-slate-600 border-slate-200'}">${f}</button>`).join("")}
    </div>
    <div class="bg-white border border-slate-200 rounded-2xl shadow-card overflow-hidden">
      <div class="scrollx"><table class="w-full text-[14px] min-w-[720px]">
        <thead><tr class="text-left text-[12px] uppercase tracking-wide text-slate-500 border-b border-slate-200">
          <th class="font-semibold px-4 py-3">Player</th><th class="font-semibold px-4 py-3">Group</th><th class="font-semibold px-4 py-3">Guardian</th>${state.role==="owner"?'<th class="font-semibold px-4 py-3 text-right">Balance</th>':""}<th class="font-semibold px-4 py-3">Status</th><th class="px-4 py-3"></th>
        </tr></thead><tbody>
        ${list.map(p=>{const g=GROUPS.find(x=>x.id===p.group);return `<tr class="border-b border-slate-100 last:border-0 hover:bg-slate-50">
          <td class="px-4 py-3"><button onclick="go('profile','${p.id}')" class="btn cursor-pointer font-semibold text-left hover:text-pitch-700">${esc(p.name)}<span class="block text-[12px] font-normal text-slate-500 tabular">${p.id} · reg ${esc(p.reg)}</span></button></td>
          <td class="px-4 py-3"><span class="inline-flex items-center gap-1.5 text-[13px] font-medium"><span class="w-2.5 h-2.5 rounded-full" style="background:${g.color}"></span>${g.name}</span></td>
          <td class="px-4 py-3 text-slate-600">${esc(p.guardian)}<span class="block text-[12px] tabular">${esc(p.phone)}</span></td>
          ${state.role==="owner"?`<td class="px-4 py-3 text-right tabular font-semibold ${p.balance?'text-red-600':'text-slate-400'}">${p.balance?LKR(p.balance):"—"}</td>`:""}
          <td class="px-4 py-3">${statusBadge(p.status)}</td>
          <td class="px-4 py-3 text-right"><button onclick="go('profile','${p.id}')" class="btn cursor-pointer touch44 w-10 h-10 inline-flex items-center justify-center rounded-lg hover:bg-slate-100" aria-label="Open ${esc(p.name)}"><i data-lucide="chevron-right" class="w-5 h-5 text-slate-500"></i></button></td>
        </tr>`;}).join("") || `<tr><td colspan="6">${emptyState("users","No players here","Try a different status filter.")}</td></tr>`}
        </tbody></table></div>
    </div>`;
};

/* ---- PLAYER PROFILE ---- */
VIEWS.profile = function(){
  const p = PLAYERS.find(x=>x.id===state.playerId) || PLAYERS[0];
  const g = GROUPS.find(x=>x.id===p.group);
  const invs = INVOICES.filter(i=>i.pid===p.id);
  return `<button onclick="go('players')" class="btn cursor-pointer touch44 inline-flex items-center gap-1.5 text-[14px] font-semibold text-slate-600 hover:text-slate-900 mb-3"><i data-lucide="arrow-left" class="w-4 h-4"></i>All players</button>`
  + `<div class="grid lg:grid-cols-3 gap-3">
    <div class="lg:col-span-2 space-y-3">
      <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5 sm:p-6">
        <div class="flex flex-wrap items-start gap-4">
          <div class="w-16 h-16 rounded-2xl bg-navy-900 text-white flex items-center justify-center font-heading font-bold text-[22px]">${esc(p.name.split(" ").map(w=>w[0]).slice(0,2).join(""))}</div>
          <div class="flex-1 min-w-[200px]">
            <div class="flex flex-wrap items-center gap-2"><h2 class="font-heading font-semibold text-[20px] sm:text-[24px]">${esc(p.name)}</h2>${statusBadge(p.status)}</div>
            <p class="text-[14px] text-slate-600 tabular">${p.id} · DOB ${esc(p.dob)} · Registered ${esc(p.reg)}</p>
            <p class="mt-1 inline-flex items-center gap-2 text-[13px] font-semibold"><span class="w-2.5 h-2.5 rounded-full" style="background:${g.color}"></span>${g.name} · ${LKR(g.fee)}/mo</p>
          </div>
          ${state.role==="owner"?`<div class="flex gap-2">${btnGhost("Edit","pencil",'onclick="playerModal(true)"')}${btnGhost("Transfer","repeat",'onclick="transferModal()"')}</div>`:""}
        </div>
        ${p.notes?`<div class="mt-4 rounded-xl bg-amberx-50 border border-amber-200 px-4 py-3 text-[14px]"><b>Note:</b> ${esc(p.notes)}</div>`:""}
        <dl class="grid sm:grid-cols-2 gap-3 mt-4 text-[14px]">
          <div class="rounded-xl border border-slate-200 p-3"><dt class="text-[12px] font-semibold uppercase tracking-wide text-slate-500">Guardian</dt><dd class="font-semibold">${esc(p.guardian)}</dd><dd class="tabular text-slate-600">${esc(p.phone)}</dd></div>
          <div class="rounded-xl border border-slate-200 p-3"><dt class="text-[12px] font-semibold uppercase tracking-wide text-slate-500">Second contact</dt><dd class="font-semibold">${esc(p.guardian2||"—")}</dd><dd class="text-slate-500 text-[13px]">Optional</dd></div>
        </dl>
      </div>
      <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5">
        <h3 class="font-heading font-semibold text-[16px] mb-1">Group history</h3>
        <p class="text-[13px] text-slate-600 mb-3">Transfers preserve attendance, invoices & payments. No silent moves.</p>
        <ol class="relative border-l-2 border-slate-200 ml-2 space-y-3 text-[14px]">
          <li class="pl-4"><span class="absolute -ml-[21px] mt-1 w-3 h-3 rounded-full bg-pitch-600"></span><b>${g.name}</b> — since Jan 2025 <span class="text-slate-500">· confirmed by owner</span></li>
          <li class="pl-4"><span class="absolute -ml-[21px] mt-1 w-3 h-3 rounded-full bg-slate-300"></span>Previous group — archived, records kept <span class="text-slate-500">· Jun 2023 – Dec 2024</span></li>
        </ol>
      </div>
      <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5">
        <div class="flex items-center justify-between mb-3"><h3 class="font-heading font-semibold text-[16px]">Invoices & payments</h3>${state.role==="owner"?btnGhost("Record payment","plus",'onclick="paymentModal()"'):""}</div>
        ${state.role!=="owner"?'<p class="text-[14px] text-slate-600">Financial records are hidden for coaches.</p>':(invs.length?`<div class="space-y-2">${invs.map(i=>`
          <button onclick="go('invoice','${i.id}')" class="btn cursor-pointer w-full text-left rounded-xl border border-slate-200 p-3 hover:border-pitch-600 flex items-center justify-between gap-2">
            <span class="text-[14px]"><b>${i.id}</b> · ${esc(i.period)} · <span class="tabular">${LKR(i.amount-i.paid)} due</span></span>${statusBadge(i.status)}
          </button>`).join("")}</div>`:emptyState("receipt","No invoices yet","Invoices appear after the next billing run."))}
      </div>
    </div>
    <div class="space-y-3">
      <div class="bg-navy-900 text-white rounded-2xl shadow-card p-5">
        <p class="text-[12px] uppercase tracking-wide text-slate-300 font-semibold">Outstanding balance</p>
        <p class="font-heading font-bold text-[30px] tabular">${state.role==="owner"?LKR(invs.reduce((a,i)=>a+(i.amount-i.paid),0)):"Hidden"}</p>
        ${state.role==="owner"?`<div class="grid grid-cols-2 gap-2 mt-3">${btnPrimary("Remind","message-circle",'onclick="toast(\'WhatsApp reminder queued for '+esc(p.guardian)+'\')"')}<button onclick="go('invoice','${(invs[0]||{}).id||'INV-2026-101'}')" class="btn cursor-pointer touch44 h-11 rounded-xl bg-white text-navy-900 text-[14px] font-semibold">Invoice</button></div>`:'<p class="text-[13px] text-slate-300">Visible to owners only.</p>'}
      </div>
      <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5">
        <h3 class="font-heading font-semibold text-[16px] mb-2">Attendance (last 4)</h3>
        ${["Present","Present","Late","Excused"].map((s,i)=>`<div class="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0 text-[14px]"><span class="text-slate-600">Session ${["Thu 09","Tue 07","Thu 02","Tue 30"][i]} Oct</span>${statusBadge(s==="Late"?"Partial":s==="Excused"?"Issued":s)}</div>`).join("")}
        <button onclick="go('sessions')" class="btn cursor-pointer text-[14px] font-semibold text-pitch-700 hover:underline mt-2">Full history →</button>
      </div>
      ${state.role==="owner"?`<div class="bg-white border border-red-200 rounded-2xl p-5">
        <h3 class="font-heading font-semibold text-[16px] text-red-700">Danger zone</h3>
        <p class="text-[13px] text-slate-600 mb-3">Withdraw keeps all history. Deletion is not allowed from the UI.</p>
        <button onclick="askConfirm('Withdraw ${esc(p.name)}?','Status becomes Withdrawn. History, invoices and payments are kept.','Withdraw',()=>toast('${esc(p.name)} withdrawn — history kept'))" class="btn cursor-pointer touch44 w-full h-11 rounded-xl border border-red-300 text-red-700 font-semibold text-[14px] hover:bg-red-50">Withdraw player</button>
      </div>`:""}
    </div>
  </div>`;
};

/* ---- GROUPS ---- */
VIEWS.groups = function(){
  if (state.role!=="owner") return denied("age-group setup");
  return sectionHead("Age groups","Configurable · suggestion needs owner confirmation · never auto-move.",
    btnPrimary("New group","plus",'onclick="toast(\'Group draft created — set age rule & fee\')"'))
  + `<div class="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">` + GROUPS.map(g=>`
    <div class="card-hover bg-white border border-slate-200 rounded-2xl shadow-card p-5">
      <div class="flex items-center gap-2 mb-2"><span class="w-3 h-3 rounded-full" style="background:${g.color}"></span><h3 class="font-heading font-semibold text-[16px]">${g.name}</h3></div>
      <p class="font-heading font-bold text-[26px] tabular">${LKR(g.fee)}<span class="text-[13px] font-body font-normal text-slate-500"> /mo</span></p>
      <p class="text-[13px] text-slate-600">${g.players} players · Tue/Thu default</p>
      <div class="flex gap-2 mt-4">
        <button onclick="toast('Fee editor: old invoices keep their snapshot')" class="btn cursor-pointer touch44 flex-1 h-10 rounded-lg border border-slate-200 text-[13px] font-semibold hover:border-pitch-600">Edit fee</button>
        <button onclick="toast('Squad list: ${g.players} players')" class="btn cursor-pointer touch44 flex-1 h-10 rounded-lg bg-navy-900 text-white text-[13px] font-semibold">Squad</button>
      </div></div>`).join("") + `</div>
  <div class="mt-3 bg-blue-50 border border-blue-200 rounded-2xl p-4 text-[14px] text-blue-900"><b>Age rule:</b> eligibility calculated on 1 January of the season. Suggestion shown at registration — owner confirms or overrides. Missing DOB → manual assignment required.</div>`;
};

/* ---- COACHES ---- */
VIEWS.coaches = function(){
  if (state.role!=="owner") return denied("coach administration");
  return sectionHead("Coaches","Assignments scope every permission a coach has.",
    btnPrimary("Add coach","user-plus",'onclick="toast(\'Invite sent — coach sets password\')"'))
  + `<div class="grid sm:grid-cols-2 gap-3">` + COACHES.map(c=>{const g=GROUPS.find(x=>x.id===c.group);return `
    <div class="card-hover bg-white border border-slate-200 rounded-2xl shadow-card p-5 flex items-center gap-4">
      <div class="w-12 h-12 rounded-full bg-navy-900 text-white flex items-center justify-center font-heading font-semibold">${esc(c.name.replace("Coach ","").slice(0,2))}</div>
      <div class="flex-1 min-w-0"><p class="font-semibold text-[15px]">${esc(c.name)}</p>
        <p class="text-[13px] text-slate-600"><span class="w-2 h-2 inline-block rounded-full" style="background:${g.color}"></span> ${g.name} · ${c.sessions} sessions/mo</p>
        <p class="text-[12px] text-slate-500 tabular">${esc(c.phone)} · in ${esc(c.checkin)}</p></div>
      <div class="text-right space-y-1">${statusBadge(c.status)}<br/><button onclick="toast('Assignment editor: ${esc(c.name)}')" class="btn cursor-pointer text-[13px] font-semibold text-pitch-700 hover:underline">Reassign</button></div>
    </div>`;}).join("") + `</div>`;
};

/* ---- SESSIONS / ATTENDANCE ---- */
VIEWS.sessions = function(){
  const s = SESSIONS.find(x=>x.id===state.sessionId) || SESSIONS[0];
  const marked = Object.values(state.attendance).filter(v=>v).length;
  return sectionHead("Sessions & attendance", esc(s.title) + " · " + esc(s.venue),
    (state.role==="owner"?btnGhost("New session","plus",'onclick="toast(\'Session draft: pick group + date — duplicates blocked\')"'):"")
    + btnPrimary("Mark all present","check-check",'onclick="markAll()"'))
  + `<div class="flex gap-2 mb-4 overflow-x-auto scrollx pb-1" role="tablist" aria-label="Sessions">
      ${SESSIONS.map(x=>`<button onclick="state.sessionId='${x.id}';go('sessions')" role="tab" aria-selected="${x.id===s.id}"
        class="btn cursor-pointer touch44 shrink-0 h-11 px-4 rounded-xl text-[13px] font-semibold border ${x.id===s.id?'bg-navy-900 text-white border-navy-900':'bg-white text-slate-600 border-slate-200'}">${esc(x.title.split("·")[0])} ${x.state==="done"?"· Done":""}</button>`).join("")}
    </div>
    <div class="rounded-2xl bg-navy-900 text-white px-4 py-3 mb-3 flex items-center justify-between text-[14px]">
      <span><b class="tabular">${marked}/${ROSTER.length}</b> marked · bulk: tap a status, then players</span>
      <button onclick="toast('Attendance saved · correction window open')" class="btn cursor-pointer touch44 h-10 px-4 rounded-lg bg-pitch-600 font-semibold text-[13px]">Save</button>
    </div>
    <div class="space-y-2">` + ROSTER.map(r=>{
      const st = state.attendance[r.id];
      const b = (k,label)=>`<button onclick="setAtt('${r.id}','${k}')" aria-pressed="${st===k}" aria-label="Mark ${esc(r.name)} ${label}"
        class="atbtn cursor-pointer touch44 flex-1 h-[52px] rounded-xl border text-[13px] font-bold ${st===k?({present:'bg-pitch-600 border-pitch-600 text-white',absent:'bg-red-600 border-red-600 text-white',late:'bg-amberx-500 border-amberx-500 text-white',excused:'bg-blue-600 border-blue-600 text-white'})[k]:'bg-white border-slate-200 text-slate-600'}">${label}</button>`;
      return `<div class="bg-white border ${st?'border-pitch-600':'border-slate-200'} rounded-2xl shadow-card p-3">
        <div class="flex items-center gap-3 mb-2 px-1">
          <span class="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center font-heading font-semibold text-[14px]">${esc(r.name.split(" ").map(w=>w[0]).slice(0,2).join(""))}</span>
          <button onclick="go('profile','${r.id}')" class="btn cursor-pointer text-left flex-1"><span class="block font-semibold text-[15px]">${esc(r.name)}</span><span class="block text-[12px] text-slate-500 tabular">${r.id}</span></button>
          ${st?`<button onclick="setAtt('${r.id}',null)" class="btn cursor-pointer text-[12px] font-semibold text-slate-400 hover:text-red-600 underline">clear</button>`:""}
        </div>
        <div class="flex gap-1.5" role="group" aria-label="Attendance for ${esc(r.name)}">${b("present","Present")}${b("absent","Absent")}${b("late","Late")}${b("excused","Excused")}</div>
      </div>`;}).join("") + `</div>
    <p class="text-[13px] text-slate-500 mt-3">Corrections need a reason and are audited. Duplicate session + duplicate attendance rows are blocked by the database.</p>`;
};

/* ---- COACH TIME ---- */
VIEWS.coachtime = function(){
  return sectionHead("Coach check-in / out","Self-reported presence — shows effort, not proof of location.",
    state.role==="owner" ? btnGhost("Correct entry","pencil",'onclick="toast(\'Correction saved with reason + audit\')"') : btnPrimary("Check in","log-in",'onclick="toast(\'Checked in 17:04 · have a great session\')"'))
  + `<div class="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">` + COACHES.filter(c=>state.role==="owner"||c.id==="C-02").map(c=>`
    <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5">
      <p class="font-semibold text-[15px]">${esc(c.name)}</p>
      <p class="text-[13px] text-slate-600 mb-2">${GROUPS.find(g=>g.id===c.group).name} · in <b class="tabular">${esc(c.checkin)}</b></p>
      ${statusBadge(c.status)}
      <div class="text-[13px] text-slate-600 mt-2 tabular">Tue 16:55 → 19:10 · 2h 15m<br/>Thu 17:02 → 19:05 · 2h 03m</div>
    </div>`).join("") + `</div>`;
};

/* ---- BILLING ---- */
VIEWS.billing = function(){
  if (state.role!=="owner") return denied("billing & invoices");
  const out = INVOICES.reduce((a,i)=>a+(i.amount-i.paid),0);
  return sectionHead("Billing & invoices","Oct 2026 · monthly · registration-anchored · snapshots on issue",
    btnGhost("Preview run","eye",'onclick="toast(\'Preview: 96 eligible · 2 skipped (inactive) · 0 duplicates\')"') + btnPrimary("Issue invoices","plus",'onclick="toast(\'102 invoices issued · PDFs queued · WhatsApp scheduled\')"'))
  + `<div class="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
      ${kpi("Invoiced · Oct",LKR(487500),"102 invoices","receipt","blue")}${kpi("Collected",LKR(312500),"64% of invoiced","wallet","green")}
      ${kpi("Outstanding",LKR(out),"this view only","alert-circle","red")}${kpi("Overdue",LKR(15500),"3 invoices","clock","amber")}
    </div>
    <div class="bg-white border border-slate-200 rounded-2xl shadow-card overflow-hidden"><div class="scrollx">
    <table class="w-full text-[14px] min-w-[760px]"><thead><tr class="text-left text-[12px] uppercase tracking-wide text-slate-500 border-b border-slate-200">
      <th class="font-semibold px-4 py-3">Invoice</th><th class="font-semibold px-4 py-3">Period</th><th class="font-semibold px-4 py-3 text-right">Amount</th><th class="font-semibold px-4 py-3 text-right">Due</th><th class="font-semibold px-4 py-3">Status</th><th class="px-4 py-3"></th></tr></thead>
      <tbody>${INVOICES.map(i=>`<tr class="border-b border-slate-100 last:border-0 hover:bg-slate-50">
        <td class="px-4 py-3"><b>${i.id}</b><span class="block text-[13px] text-slate-600">${esc(i.player)} · ${esc(i.group)}</span></td>
        <td class="px-4 py-3 text-slate-600">${esc(i.period)}<span class="block text-[12px]">due ${esc(i.due)}</span></td>
        <td class="px-4 py-3 text-right tabular font-semibold">${LKR(i.amount)}<span class="block text-[12px] font-normal text-slate-500">paid ${LKR(i.paid)}</span></td>
        <td class="px-4 py-3 text-right tabular font-semibold ${i.amount-i.paid?'text-red-600':'text-slate-400'}">${LKR(i.amount-i.paid)}</td>
        <td class="px-4 py-3">${statusBadge(i.status)}</td>
        <td class="px-4 py-3 text-right"><button onclick="go('invoice','${i.id}')" class="btn cursor-pointer touch44 h-10 px-3 rounded-lg bg-navy-900 text-white text-[13px] font-semibold">Open</button></td>
      </tr>`).join("")}</tbody></table></div></div>`;
};

/* ---- INVOICE DETAIL ---- */
VIEWS.invoice = function(){
  if (state.role!=="owner") return denied("invoice detail");
  const i = INVOICES.find(x=>x.id===state.invoiceId) || INVOICES[0];
  const left = i.amount - i.paid;
  return `<button onclick="go('billing')" class="btn cursor-pointer touch44 inline-flex items-center gap-1.5 text-[14px] font-semibold text-slate-600 hover:text-slate-900 mb-3"><i data-lucide="arrow-left" class="w-4 h-4"></i>All invoices</button>`
  + `<div class="grid lg:grid-cols-3 gap-3">
    <div class="lg:col-span-2 bg-white border border-slate-200 rounded-2xl shadow-card p-5 sm:p-6">
      <div class="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-slate-200">
        <div><p class="text-[12px] font-bold tracking-wide text-slate-500">INSPIRE ACADEMY FC · +94 11 234 5678</p>
        <h2 class="font-heading font-bold text-[24px]">${i.id}</h2>
        <p class="text-[14px] text-slate-600">${esc(i.player)} (${i.pid}) · ${esc(i.group)} · ${esc(i.period)} · due ${esc(i.due)}</p></div>
        ${statusBadge(i.status)}
      </div>
      <table class="w-full text-[14px] mt-2"><tbody>
        <tr class="border-b border-slate-100"><td class="py-2.5">Monthly fee — ${esc(i.group)} (${esc(i.period)})</td><td class="py-2.5 text-right tabular">${LKR(i.amount)}</td></tr>
        <tr class="border-b border-slate-100 text-slate-600"><td class="py-2.5">Paid to date</td><td class="py-2.5 text-right tabular">− ${LKR(i.paid)}</td></tr>
        <tr><td class="py-2.5 font-heading font-bold text-[16px]">Balance due</td><td class="py-2.5 text-right font-heading font-bold text-[18px] tabular ${left?'text-red-600':''}">${LKR(left)}</td></tr>
      </tbody></table>
      <p class="text-[12px] text-slate-500 mt-2">Snapshot at issue — fee edits never rewrite this invoice. Pay by bank transfer ref <b>${i.id}</b> or cash at the office.</p>
      <div class="flex flex-wrap gap-2 mt-4">
        ${btnPrimary("Record payment","plus",'onclick="paymentModal()"')}${btnGhost("PDF invoice","file-text",'onclick="toast(\'PDF generated: '+i.id+'.pdf\')"')}${btnGhost("Send via WhatsApp","message-circle",'onclick="toast(\'Invoice queued via OpenWA\')"')}
        <button onclick="askConfirm('Void ${i.id}?','Voided invoices leave normal balances. A correction invoice can be issued after.','Void invoice',()=>toast('${i.id} voided with audit'))" class="btn cursor-pointer touch44 h-11 px-4 rounded-xl border border-red-300 text-red-700 text-[14px] font-semibold hover:bg-red-50">Void</button>
      </div>
    </div>
    <div class="space-y-3">
      <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5">
        <h3 class="font-heading font-semibold text-[16px] mb-2">Payments & proof</h3>
        ${i.paid?`<div class="rounded-xl border border-slate-200 p-3 text-[14px] mb-2"><b class="tabular">${LKR(i.paid)}</b> · cash · verified<span class="block text-[12px] text-slate-500">PAY-881 · 06 Oct · receipt issued</span></div>`
        :`<p class="text-[14px] text-slate-600 mb-2">No payments yet. Uploaded proof is <b>not</b> a confirmed payment until an owner verifies it.</p>`}
        <button onclick="toast('Proof viewer: private signed URL, expires in 15 min')" class="btn cursor-pointer text-[14px] font-semibold text-pitch-700 hover:underline">View proof (owner-only) →</button>
      </div>
      <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5">
        <h3 class="font-heading font-semibold text-[16px] mb-2">Receipt</h3>
        <p class="text-[13px] text-slate-600">Receipts are issued per recorded payment with reference + allocation.</p>
        <button onclick="toast('Receipt PDF: PAY-881 · ${LKR(i.paid||2000)}')" class="btn cursor-pointer touch44 mt-2 w-full h-11 rounded-xl border border-slate-200 font-semibold text-[14px] hover:border-pitch-600">Download receipt</button>
      </div>
    </div></div>`;
};

/* ---- WHATSAPP ---- */
VIEWS.whatsapp = function(){
  if (state.role!=="owner") return denied("WhatsApp controls");
  return sectionHead("WhatsApp reminders (OpenWA)","Server-side only · never expose the API key · pause anytime",
    btnGhost("Pause automation","pause",'onclick="toast(\'Automated messaging paused\')"') + btnPrimary("Retry failed","refresh-cw",'onclick="toast(\'1 message re-queued — no duplicates\')"'))
  + `<div class="rounded-2xl border border-amber-300 bg-amberx-50 p-4 text-[14px] mb-3"><b>Operational note:</b> OpenWA uses an unofficial reverse-engineered client — sessions can disconnect. Status here reflects provider states only; nothing is marked delivered unless the provider reports it.</div>
  <div class="bg-white border border-slate-200 rounded-2xl shadow-card overflow-hidden"><div class="scrollx">
  <table class="w-full text-[14px] min-w-[720px]"><thead><tr class="text-left text-[12px] uppercase tracking-wide text-slate-500 border-b border-slate-200">
    <th class="font-semibold px-4 py-3">Recipient</th><th class="font-semibold px-4 py-3">Template</th><th class="font-semibold px-4 py-3">Status</th><th class="px-4 py-3"></th></tr></thead>
  <tbody>${MSGS.map(m=>`<tr class="border-b border-slate-100 last:border-0 hover:bg-slate-50">
    <td class="px-4 py-3"><b>${esc(m.to)}</b><span class="block text-[12px] text-slate-500">${m.id} · ${esc(m.time)}</span></td>
    <td class="px-4 py-3">${esc(m.tpl)}<span class="block text-[12px] text-slate-500">${m.ref} · amount · due date · secure link</span></td>
    <td class="px-4 py-3">${statusBadge(m.status)}</td>
    <td class="px-4 py-3 text-right">${m.status==="Failed"?`<button onclick="toast('Re-queued ${m.id} with idempotency key')" class="btn cursor-pointer touch44 h-10 px-3 rounded-lg bg-navy-900 text-white text-[13px] font-semibold">Retry</button>`:`<button onclick="toast('${m.id}: ${m.status} confirmed by provider')" class="btn cursor-pointer touch44 h-10 px-3 rounded-lg border border-slate-200 text-[13px] font-semibold">Details</button>`}</td>
  </tr>`).join("")}</tbody></table></div></div>`;
};

/* ---- REPORTS ---- */
VIEWS.reports = function(){
  if (state.role!=="owner") return denied("financial reports");
  const row = (l,v)=>`<div class="flex justify-between py-2 border-b border-slate-100 last:border-0 text-[14px]"><span class="text-slate-600">${l}</span><b class="tabular">${v}</b></div>`;
  return sectionHead("Reports & exports","Filters + date ranges · CSV for players, attendance, invoices, payments",
    btnGhost("Export CSV","download",'onclick="toast(\'CSV exported with current filters\')"'))
  + `<div class="grid md:grid-cols-3 gap-3">
    <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5"><h3 class="font-heading font-semibold text-[16px] mb-2">Finance · Oct</h3>${row("Invoiced",LKR(487500))}${row("Collected",LKR(312500))}${row("Collection rate","64%")}${row("Overdue",LKR(15500))}</div>
    <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5"><h3 class="font-heading font-semibold text-[16px] mb-2">Attendance · Oct</h3>${row("Sessions held","18")}${row("Avg. presence","86%")}${row("Excused","23")}${row("No-shows","41")}</div>
    <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5"><h3 class="font-heading font-semibold text-[16px] mb-2">Squad</h3>${row("Active","102")}${row("New this month","6")}${row("Inactive held","9")}${row("Withdrawn (kept)","4")}</div>
  </div>`;
};

/* ---- USERS / SETTINGS / AUDIT ---- */
VIEWS.users = function(){
  if (state.role!=="owner") return denied("user management");
  return sectionHead("Users","Multiple owner accounts · coaches scoped to groups", btnPrimary("Invite user","user-plus",'onclick="toast(\'Invite sent\')"'))
  + `<div class="bg-white border border-slate-200 rounded-2xl shadow-card divide-y divide-slate-100">` +
  [["S. Perera","Owner · full access","Active"],["R. Fernando","Owner · full access","Active"],["Coach Nuwan","Coach · U13 only","Active"],["Coach Faris","Coach · U16 only","Suspended"]].map(([n,r,s])=>`
    <div class="flex items-center gap-3 p-4"><span class="w-10 h-10 rounded-full bg-navy-900 text-white flex items-center justify-center font-heading font-semibold text-[13px]">${n[0]}</span>
    <div class="flex-1"><p class="font-semibold text-[14px]">${n}</p><p class="text-[13px] text-slate-600">${r}</p></div>${statusBadge(s)}</div>`).join("") + `</div>`;
};
VIEWS.settings = function(){
  if (state.role!=="owner") return denied("academy settings");
  return sectionHead("Academy settings","Billing rules, season & messaging", btnPrimary("Save changes","save",'onclick="toast(\'Settings saved with audit entry\')"'))
  + `<div class="grid md:grid-cols-2 gap-3">
    <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5"><h3 class="font-heading font-semibold text-[16px] mb-3">Billing</h3>
      ${[["Billing plan","Monthly"],["Period anchor","Registration date"],["Due date rule","5th of month, fixed"],["Partial payments","Allowed, allocated oldest-first"],["Currency","LKR — whole rupees, no decimals"]].map(([k,v])=>`
      <label class="block mb-3"><span class="text-[13px] font-semibold text-slate-600">${k}</span>
      <input value="${v}" class="mt-1 w-full h-11 rounded-xl border border-slate-200 px-3 text-[14px] focus:border-pitch-600 outline-none" /></label>`).join("")}
    </div>
    <div class="space-y-3">
      <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5"><h3 class="font-heading font-semibold text-[16px] mb-3">Season & sessions</h3>
        <label class="block mb-3"><span class="text-[13px] font-semibold text-slate-600">Season age-cutoff date</span><input type="date" value="2026-01-01" class="mt-1 w-full h-11 rounded-xl border border-slate-200 px-3 text-[14px] outline-none" /></label>
        <label class="block"><span class="text-[13px] font-semibold text-slate-600">Default training days</span><input value="Tuesday, Thursday" class="mt-1 w-full h-11 rounded-xl border border-slate-200 px-3 text-[14px] outline-none" /></label>
        <p class="text-[12px] text-slate-500 mt-2">Defaults only — every session is scheduled explicitly.</p></div>
      <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5"><h3 class="font-heading font-semibold text-[16px] mb-2">WhatsApp automation</h3>
        ${[["Remind before due (days)","2"],["Overdue reminders","3, 7, 14 days"],["Quiet hours","21:00 – 08:00"]].map(([k,v])=>`
        <label class="block mb-3"><span class="text-[13px] font-semibold text-slate-600">${k}</span><input value="${v}" class="mt-1 w-full h-11 rounded-xl border border-slate-200 px-3 text-[14px] outline-none" /></label>`).join("")}
      </div>
    </div></div>`;
};
VIEWS.audit = function(){
  return sectionHead("Audit & system health","Immutable log · corrections tracked · backups tested",
    state.role==="owner"?btnGhost("Export log","download",'onclick="toast(\'Audit CSV exported\')"'):"")
  + `<div class="grid lg:grid-cols-3 gap-3">
    <div class="lg:col-span-2 bg-white border border-slate-200 rounded-2xl shadow-card divide-y divide-slate-100">` +
    AUDIT.map(a=>`<div class="p-4 text-[14px]"><p class="font-semibold">${esc(a.what)}</p><p class="text-[13px] text-slate-500">${esc(a.t)} · ${esc(a.who)}</p></div>`).join("") + `</div>
    <div class="space-y-3">
      <div class="bg-white border border-slate-200 rounded-2xl shadow-card p-5 text-[14px]">${[["API","Operational","green"],["Database","Healthy · backup 02:00","green"],["OpenWA session","Connected","green"],["PDF worker","Idle","slate"],["Storage","62% private bucket","amber"]].map(([k,v,c])=>`
        <div class="flex justify-between py-1.5 border-b border-slate-100 last:border-0"><span class="text-slate-600">${k}</span><b class="${c==='green'?'text-emerald-700':c==='amber'?'text-amber-600':'text-slate-600'}">${v}</b></div>`).join("")}</div>
      ${state.role!=="owner"?'<p class="text-[13px] text-slate-500">Coaches see health, not the full log.</p>':""}
    </div></div>`;
};

/* ================= ACTIONS / MODALS ================= */
function setAtt(id, val){
  state.attendance[id] = (state.attendance[id]===val) ? state.attendance[id] : val;
  if (val===null) state.attendance[id]=null;
  go("sessions");
  const r = ROSTER.find(x=>x.id===id);
  toast(val ? `${r.name} → ${val}` : `${r.name} cleared`);
}
function markAll(){ ROSTER.forEach(r=>state.attendance[r.id]="present"); go("sessions"); toast("All marked present — tap to adjust"); }

function playerModal(edit){
  openModal(`<div class="p-6">
    <h3 class="font-heading font-semibold text-[18px]">${edit?"Edit player":"Register player"}</h3>
    <p class="text-[13px] text-slate-600 mb-4">Duplicate check runs on name + guardian phone.</p>
    <div class="rounded-xl border border-amber-300 bg-amberx-50 px-3 py-2 text-[13px] mb-3">Possible duplicate: <b>Shenal Perera</b> · same guardian phone. Confirm before saving.</div>
    <div class="grid sm:grid-cols-2 gap-3">
      <label class="block"><span class="text-[13px] font-semibold">Player name *</span><input value="${edit?"Aadhil Rahman":""}" placeholder="Full name" class="mt-1 w-full h-11 rounded-xl border border-slate-200 px-3 text-[14px] outline-none focus:border-pitch-600"/></label>
      <label class="block"><span class="text-[13px] font-semibold">Date of birth</span><input type="date" value="2011-11-25" class="mt-1 w-full h-11 rounded-xl border border-slate-200 px-3 text-[14px] outline-none"/></label>
      <label class="block"><span class="text-[13px] font-semibold">Guardian name *</span><input value="${edit?"Faslan Rahman":""}" class="mt-1 w-full h-11 rounded-xl border border-slate-200 px-3 text-[14px] outline-none"/></label>
      <label class="block"><span class="text-[13px] font-semibold">Guardian phone *</span><input inputmode="tel" value="${edit?"+94 76 441 9021":""}" placeholder="+94 …" class="mt-1 w-full h-11 rounded-xl border border-slate-200 px-3 text-[14px] outline-none"/></label>
      <label class="block"><span class="text-[13px] font-semibold">Age group (suggested: U13)</span><select class="mt-1 w-full h-11 rounded-xl border border-slate-200 px-3 text-[14px] bg-white"><option>Under 13 (suggested)</option><option>Under 10</option><option>Under 16</option></select></label>
      <label class="block"><span class="text-[13px] font-semibold">Status</span><select class="mt-1 w-full h-11 rounded-xl border border-slate-200 px-3 text-[14px] bg-white"><option>Active</option><option>Inactive</option></select></label>
    </div>
    <div class="grid grid-cols-2 gap-2 mt-5">
      <button onclick="closeModal()" class="btn cursor-pointer touch44 h-12 rounded-xl border border-slate-200 font-semibold">Cancel</button>
      <button onclick="closeModal();toast('${edit?"Player updated":"Player registered — invoice preview ready"}')" class="btn cursor-pointer touch44 h-12 rounded-xl bg-pitch-600 text-white font-semibold hover:bg-pitch-700">${edit?"Save":"Register"}</button>
    </div></div>`);
}
function transferModal(){
  openModal(`<div class="p-6"><h3 class="font-heading font-semibold text-[18px]">Transfer group</h3>
    <p class="text-[13px] text-slate-600 mb-4">History, attendance, invoices & payments move with the player.</p>
    <label class="block mb-3"><span class="text-[13px] font-semibold">New group</span><select class="mt-1 w-full h-11 rounded-xl border border-slate-200 px-3 text-[14px] bg-white"><option>Under 16</option><option>Under 13 (current)</option><option>Under 19</option></select></label>
    <label class="block mb-4"><span class="text-[13px] font-semibold">Reason *</span><input placeholder="e.g. aged up, coach decision" class="mt-1 w-full h-11 rounded-xl border border-slate-200 px-3 text-[14px] outline-none"/></label>
    <div class="grid grid-cols-2 gap-2"><button onclick="closeModal()" class="btn cursor-pointer touch44 h-12 rounded-xl border border-slate-200 font-semibold">Cancel</button>
    <button onclick="closeModal();toast('Transfer recorded with history')" class="btn cursor-pointer touch44 h-12 rounded-xl bg-navy-900 text-white font-semibold">Confirm</button></div></div>`);
}
function paymentModal(){
  openModal(`<div class="p-6"><h3 class="font-heading font-semibold text-[18px]">Record payment</h3>
    <p class="text-[13px] text-slate-600 mb-4">Allocated oldest-first. Proof ≠ confirmed until verified.</p>
    <div class="grid grid-cols-2 gap-3 mb-3">
      <label class="block"><span class="text-[13px] font-semibold">Amount (LKR) *</span><input inputmode="numeric" value="5000" class="mt-1 w-full h-11 rounded-xl border border-slate-200 px-3 text-[14px] tabular outline-none"/></label>
      <label class="block"><span class="text-[13px] font-semibold">Method *</span><select class="mt-1 w-full h-11 rounded-xl border border-slate-200 px-3 text-[14px] bg-white"><option>Cash</option><option>Bank transfer</option><option>Other</option></select></label>
    </div>
    <label class="block mb-3"><span class="text-[13px] font-semibold">Reference *</span><input value="TRF-881201" class="mt-1 w-full h-11 rounded-xl border border-slate-200 px-3 text-[14px] outline-none"/></label>
    <label class="block mb-4"><span class="text-[13px] font-semibold">Proof (optional, ≤5 MB)</span><input type="file" accept=".jpg,.png,.pdf" class="mt-1 w-full text-[14px]"/></label>
    <div class="grid grid-cols-2 gap-2"><button onclick="closeModal()" class="btn cursor-pointer touch44 h-12 rounded-xl border border-slate-200 font-semibold">Cancel</button>
    <button onclick="closeModal();toast('Payment recorded — receipt ready')" class="btn cursor-pointer touch44 h-12 rounded-xl bg-pitch-600 text-white font-semibold hover:bg-pitch-700">Save</button></div></div>`);
}

/* ================= WIRING ================= */
function toggleRole(){
  state.role = state.role==="owner" ? "coach" : "owner";
  if (state.role==="coach" && ["billing","invoice","groups","coaches","whatsapp","reports","users","settings"].includes(state.view)) state.view = "dashboard";
  go(state.view);
  toast(state.role==="owner" ? "Owner view — full access" : "Coach view — U13 scope only");
}
document.addEventListener("click", e=>{
  if (e.target.closest("[data-close-modal]")) closeModal();
  if (e.target.closest("[data-close-more]")) $("#moreSheet").classList.add("hidden");
});
document.addEventListener("keydown", e=>{ if (e.key==="Escape"){ closeModal(); $("#moreSheet").classList.add("hidden"); const c=$("#confirm"); c.classList.add("hidden"); c.classList.remove("flex"); }});
$("#rolePill").addEventListener("click", toggleRole);
$("#roleSwitchSide").addEventListener("click", toggleRole);
$("#confirmCancel").addEventListener("click", ()=>{ const c=$("#confirm"); c.classList.add("hidden"); c.classList.remove("flex"); });
$("#confirmOk").addEventListener("click", ()=>{ const c=$("#confirm"); c.classList.add("hidden"); c.classList.remove("flex"); if (confirmCb) confirmCb(); });
document.getElementById("globalSearch")?.addEventListener("keydown", e=>{
  if (e.key==="Enter"){ state.playerFilter="All"; go("players"); toast("Search results for: " + e.target.value); }
});

go("dashboard");
