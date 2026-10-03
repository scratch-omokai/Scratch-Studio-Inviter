const $ = (id) => document.getElementById(id);
let tabId = null, users = [], timer = null;

for (const k of ["src", "dst", "delay", "max", "ex", "relationUser", "profileKeywords"]) {
  const el = $(k);
  if (!el) continue;
  const v = localStorage.getItem("si_" + k);
  if (v !== null) el.value = v;
  el.addEventListener("input", () => localStorage.setItem("si_" + k, el.value));
}

// ランダム加算チェックボックスの状態を保存・復元
const savedJitter = localStorage.getItem("si_jitter");
if (savedJitter !== null) $("jitter").checked = savedJitter === "1";
$("jitter").addEventListener("change", () => localStorage.setItem("si_jitter", $("jitter").checked ? "1" : "0"));

async function findTab() {
  let tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: "https://scratch.mit.edu/*" });
  if (!tabs.length) tabs = await chrome.tabs.query({ url: "https://scratch.mit.edu/*" });
  return tabs.length ? tabs[0].id : null;
}

async function send(msg) {
  if (tabId == null) tabId = await findTab();
  if (tabId == null) throw new Error("scratch.mit.edu のタブを開き、ログインしてから使ってください");
  try { return await chrome.tabs.sendMessage(tabId, msg); }
  catch {
    tabId = null;
    throw new Error("scratch.mit.edu のタブを再読み込みしてから、もう一度試してください");
  }
}

const showErr = (m) => ($("err").textContent = m || "");
const isId = (s) => /^\d+$/.test(s);
const splitWords = (s) => s.split(/[\s,、]+/).filter(Boolean);

function selected() {
  const ex = new Set(splitWords($("ex").value).map((s) => s.toLowerCase()));
  const max = Math.min(4000, Math.max(1, parseInt($("max").value, 10) || 100));
  return users.filter((u) => !ex.has(u.toLowerCase())).slice(0, max);
}

function renderUserList() {
  $("userCount").textContent = `${users.length}人（招待時の除外・上限適用後: ${selected().length}人）`;
  const box = $("userList");
  box.replaceChildren();

  if (!users.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "まだユーザーがいません。";
    box.appendChild(empty);
    return;
  }

  users.forEach((name, i) => {
    const row = document.createElement("div");
    row.className = "userRow";
    const num = document.createElement("span");
    num.className = "userNum";
    num.textContent = `${i + 1}.`;
    const link = document.createElement("a");
    link.href = `https://scratch.mit.edu/users/${encodeURIComponent(name)}/`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = name;
    row.append(num, link);
    box.appendChild(row);
  });
}

// ログ1行の色分け(Adderと同じ ok=緑 / warn=黄 / err=赤)
function logClass(text) {
  if (/^(✓|終了)/.test(text)) return "ok";
  if (/^(!|エラー)/.test(text)) return "err";
  if (/^(×|-|\?|除外|停止|プロフィール除外を中断|存在確認を中断)/.test(text)) return "warn";
  return "";
}

let lastLogKey = "";
function renderLog(lines) {
  const key = `${lines.length}|${lines[lines.length - 1] || ""}`;
  if (key === lastLogKey) return;
  lastLogKey = key;

  const box = $("log");
  const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  const rows = document.createDocumentFragment();
  for (const line of lines) {
    const m = String(line).match(/^(\d{2}:\d{2}:\d{2}) ([\s\S]*)$/);
    const text = m ? m[2] : String(line);
    const row = document.createElement("div");
    const cls = logClass(text);
    if (cls) row.className = cls;
    if (m) {
      const t = document.createElement("span");
      t.className = "time";
      t.textContent = m[1] + " ";
      row.appendChild(t);
    }
    row.appendChild(document.createTextNode(text));
    rows.appendChild(row);
  }
  box.replaceChildren(rows);
  if (atEnd) box.scrollTop = box.scrollHeight;
}

function render(s) {
  if (Array.isArray(s.users)) users = s.users;

  const busy = ["running", "collecting", "adding", "filtering", "checking"].includes(s.phase);
  ["collect", "addFollowing", "addFollowers", "filterProfile", "clearUsers", "excludeUsers", "removeInvalid", "importUsers"].forEach((id) => $(id).disabled = busy);
  $("stop").disabled = s.phase !== "running";
  $("start").disabled = busy || !users.length;
  $("start").textContent = users.length ? `${selected().length}人を招待` : "招待を開始";

  const counts = s.counts || { invited: 0, skipped: 0, notfound: 0, failed: 0 };
  $("summary").textContent = s.phase === "idle" && !users.length ? "" :
    (s.phase === "running" || s.phase === "finished")
      ? `${s.done}/${s.total}人 — 招待 ${counts.invited} / スキップ ${counts.skipped} / 見つからない ${counts.notfound} / 失敗 ${counts.failed}`
      : `招待リスト: ${users.length}人（除外・上限適用後 ${selected().length}人）`;

  if (s.busyMessage) $("summary").textContent = s.busyMessage;
  $("progressText").textContent = s.progressText || "";
  $("bar").hidden = !(s.phase === "running" || s.phase === "finished");
  $("bar").max = Math.max(1, s.total || 1);
  $("bar").value = Math.min(s.done || 0, s.total || 1);

  renderLog(s.log || []);
  renderUserList();
}

async function poll() {
  try { render(await send({ type: "status" })); showErr(""); }
  catch (e) { showErr(e.message); }
}

$("collect").onclick = async () => {
  showErr("");
  const src = $("src").value.trim();
  if (!isId(src)) return showErr("元スタジオIDは数字で入力してください");
  try {
    const r = await send({ type: "collect", sourceId: src });
    if (!r.ok) showErr(r.error);
    await poll();
  } catch (e) { showErr(e.message); }
};

async function addRelation(type) {
  showErr("");
  const username = $("relationUser").value.trim();
  if (!username) return showErr("ユーザー名を入力してください");
  try {
    const r = await send({ type, username });
    if (!r.ok) showErr(r.error);
    await poll();
  } catch (e) { showErr(e.message); }
}

$("addFollowing").onclick = () => addRelation("addFollowing");
$("addFollowers").onclick = () => addRelation("addFollowers");

$("filterProfile").onclick = async () => {
  showErr("");
  const keywords = splitWords($("profileKeywords").value);
  if (!keywords.length) return showErr("除外したいプロフィールワードを入力してください");
  if (!users.length) return showErr("招待リストにユーザーがいません");
  if (!confirm(`現在の${users.length}人について、「私について」「私が取り組んでいる事」に指定ワードが含まれるユーザーを除外します。\n\n除外ワード: ${keywords.join(", ")}\n\n実行しますか？`)) return;
  try {
    const r = await send({ type: "filterProfile", keywords });
    if (!r.ok) showErr(r.error);
    await poll();
  } catch (e) { showErr(e.message); }
};

$("excludeUsers").onclick = async () => {
  showErr("");
  const names = splitWords($("ex").value);
  if (!names.length) return showErr("除外するユーザー名を入力してください");
  if (!users.length) return showErr("招待リストにユーザーがいません");
  if (!confirm(`招待リストから、指定した${names.length}件のユーザー名に一致する人を削除します。よろしいですか？`)) return;
  try {
    const r = await send({ type: "excludeUsers", keywords: names });
    if (!r.ok) showErr(r.error);
    await poll();
  } catch (e) { showErr(e.message); }
};

$("removeInvalid").onclick = async () => {
  showErr("");
  if (!users.length) return showErr("招待リストにユーザーがいません");
  if (!confirm(`招待リストの${users.length}人について、Scratch上に存在するか確認し、存在しないユーザーを削除します。\n時間がかかる場合があります。実行しますか？`)) return;
  try {
    const r = await send({ type: "removeInvalid" });
    if (!r.ok) showErr(r.error);
    await poll();
  } catch (e) { showErr(e.message); }
};

$("exportUsers").onclick = () => {
  $("userListText").value = users.join("\n");
};

$("importUsers").onclick = async () => {
  showErr("");
  const list = splitWords($("userListText").value);
  if (!list.length) return showErr("読み込むユーザー名がありません");
  if (!confirm(`現在の招待リスト(${users.length}人)を、テキストの内容(${list.length}件)で置き換えます。よろしいですか？`)) return;
  try {
    const r = await send({ type: "importUsers", users: list });
    if (!r.ok) showErr(r.error);
    await poll();
  } catch (e) { showErr(e.message); }
};

$("clearUsers").onclick = async () => {
  if (!users.length || !confirm(`招待リスト ${users.length}人をすべて削除します。よろしいですか？`)) return;
  try {
    const r = await send({ type: "clearUsers" });
    if (!r.ok) showErr(r.error);
    await poll();
  } catch (e) { showErr(e.message); }
};

$("start").onclick = async () => {
  showErr("");
  const dst = $("dst").value.trim();
  if (!isId(dst)) return showErr("招待先スタジオIDは数字で入力してください");
  if (dst === $("src").value.trim()) return showErr("元と招待先が同じスタジオです");
  const list = selected();
  const delay = Math.max(0.1, parseFloat($("delay").value) || 3);
  if (!list.length) return showErr("招待する対象がいません");
  const jitter = $("jitter").checked;
  const min = Math.ceil((list.length * delay * (jitter ? 1.25 : 1)) / 60);
  if (!confirm(`${list.length}人を、スタジオ ${dst} に招待します(約${min}分)。\n実行中は scratch.mit.edu のタブを閉じたり移動したりしないでください。\nよろしいですか?`)) return;
  try {
    const r = await send({ type: "start", targetId: dst, users: list, delayMs: Math.round(delay * 1000), jitter });
    if (!r.ok) showErr(r.error);
    await poll();
  } catch (e) { showErr(e.message); }
};

$("copyLog").onclick = async () => {
  const btn = $("copyLog");
  try {
    await navigator.clipboard.writeText($("log").innerText);
    btn.textContent = "コピーしました";
  } catch {
    btn.textContent = "コピー失敗";
  }
  setTimeout(() => (btn.textContent = "コピー"), 1500);
};

$("clearLog").onclick = async () => {
  try {
    await send({ type: "clearLog" });
    await poll();
  } catch (e) { showErr(e.message); }
};

$("stop").onclick = () => send({ type: "stop" }).catch((e) => showErr(e.message));
["ex", "max"].forEach((k) => $(k).addEventListener("input", poll));

poll();
timer = setInterval(poll, 800);
