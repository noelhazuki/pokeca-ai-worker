const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const TCGDEX_BASE = "https://api.tcgdex.net/v2/ja";

// ▼ cardList検証 (register_meta / register_mine 共通)
// 公式8分類。各カテゴリは省略可（そのデッキで未使用なら書かなくてよい）だが、
// 書く場合は必ず { cardId: string, count: number(1以上) } の配列にする。
const CARD_LIST_CATEGORIES = [
  "pokemon", "goods", "tools", "technical", "supporters", "stadiums", "energy", "aceSpec"
];

function validateCardList(cardList) {
  if (!cardList || typeof cardList !== "object" || Array.isArray(cardList)) {
    return "cardListはオブジェクト形式（カテゴリごとの配列）にしてな";
  }

  for (const key of Object.keys(cardList)) {
    if (!CARD_LIST_CATEGORIES.includes(key)) {
      return `cardListに未知のカテゴリ "${key}" が入ってるで（許可カテゴリ: ${CARD_LIST_CATEGORIES.join(", ")}）`;
    }
  }

  for (const category of CARD_LIST_CATEGORIES) {
    if (!(category in cardList)) continue;
    const entries = cardList[category];
    if (!Array.isArray(entries)) {
      return `cardList.${category}は配列にしてな`;
    }
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return `cardList.${category}の要素は { cardId, count } か { provisional, tempName, count }（仮登録）の形にしてな`;
      }
      if (typeof entry.count !== "number" || !Number.isInteger(entry.count) || entry.count < 1) {
        return `cardList.${category}のcountは1以上の整数にしてな`;
      }
      // 仮登録エントリー（TCGdex未収録 or 照合未実施）：cardId無し、tempNameのみ必須
      if (entry.provisional === true) {
        if (typeof entry.tempName !== "string" || entry.tempName.trim() === "") {
          return `cardList.${category}の仮登録要素にtempName（文字列）が無いで`;
        }
        // awaitStatus/waitDaysは任意項目（無ければapplyProvisionalAwaitDefaultsで初期値が入る）。
        // 送られてきた場合のみ型チェックする。
        if ("awaitStatus" in entry && entry.awaitStatus !== "waiting" && entry.awaitStatus !== "manual") {
          return `cardList.${category}の仮登録要素のawaitStatusは'waiting'か'manual'にしてな`;
        }
        if ("waitDays" in entry && (typeof entry.waitDays !== "number" || !Number.isInteger(entry.waitDays) || entry.waitDays < 1)) {
          return `cardList.${category}の仮登録要素のwaitDaysは1以上の整数にしてな`;
        }
        continue;
      }
      if (typeof entry.cardId !== "string" || entry.cardId.trim() === "") {
        return `cardList.${category}にcardId（文字列）が無い要素があるで`;
      }
    }
  }

  return null; // 問題なし
}
// ▲ cardList検証 (register_meta / register_mine 共通)

// ▼ provisional awaitStatus初期値付与 (register_meta / register_mine / update_mine 共通)
// 2026-07-20設計確定分の実装。provisionalエントリーにregisteredAt/awaitStatus/waitDaysが
// 無ければ、登録・更新のこの時点で初期値を埋める。既に値が入っている場合（recheck_mine後の
// 再保存や、manual切替ボタンからの部分更新等）は上書きしない＝呼んでも安全な「不足分だけ埋める」関数。
// - registeredAt: 未指定ならこの関数を呼んだ時刻をISO文字列で記録（サーバー側の時刻を正とする）
// - awaitStatus: 明示的に'manual'が送られてきた場合のみそちらを採用。それ以外（未指定 or 不正値）は'waiting'
// - waitDays: 未指定 or 不正値なら30日固定（デフォルト）
function applyProvisionalAwaitDefaults(cardList) {
  const now = new Date().toISOString();
  for (const category of CARD_LIST_CATEGORIES) {
    const entries = cardList[category];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry.provisional !== true) continue;
      if (!entry.registeredAt) entry.registeredAt = now;
      if (entry.awaitStatus !== "manual") entry.awaitStatus = "waiting";
      if (typeof entry.waitDays !== "number" || !Number.isInteger(entry.waitDays) || entry.waitDays < 1) {
        entry.waitDays = 30;
      }
    }
  }
  return cardList;
}
// ▲ provisional awaitStatus初期値付与

// ▼ setInfo→TCGdex id変換 (resolve_card_id専用)
// 例：「SV11W 043/086」→スペースをハイフンに置換→「/」より前だけ取る→「SV11W-043」
function convertSetInfoToCardId(setInfo) {
  if (typeof setInfo !== "string" || setInfo.trim() === "") return null;
  const replaced = setInfo.replace(/ /g, "-");
  const cardId = replaced.split("/")[0];
  return cardId || null;
}
// ▲ setInfo→TCGdex id変換

// ▼ カード取得ヘルパー (get_card / validateRegulationLegality 共通) ※遅延キャッシュ方式
// card:{cardId} があればそれを返す。無ければTCGdexのカード単体APIを叩いてKVに保存してから返す。
async function getCardData(env, cardId) {
  const cacheKey = "card:" + cardId;
  const cached = await env.KV.get(cacheKey);
  if (cached) {
    return { card: JSON.parse(cached), cached: true };
  }

  const cardRes = await fetch(`${TCGDEX_BASE}/cards/${cardId}`);
  if (!cardRes.ok) {
    return { card: null, cached: false };
  }

  const cardData = await cardRes.json();
  await env.KV.put(cacheKey, JSON.stringify(cardData));
  return { card: cardData, cached: false };
}
// ▲ カード取得ヘルパー

// ▼ セット取得ヘルパー (トレーナーズ・エネの名前照合専用) ※遅延キャッシュ方式
// set:{setId} があればそれを返す。無ければTCGdexのセット単体APIを叩いてKVに保存してから返す。
// getCardDataと同じ遅延キャッシュ方式。cards配列（id/localId/name）を使って名前照合する。
async function getSetData(env, setId) {
  const cacheKey = "set:" + setId;
  const cached = await env.KV.get(cacheKey);
  if (cached) {
    return { set: JSON.parse(cached), cached: true };
  }

  const setRes = await fetch(`${TCGDEX_BASE}/sets/${setId}`);
  if (!setRes.ok) {
    return { set: null, cached: false };
  }

  const setData = await setRes.json();
  await env.KV.put(cacheKey, JSON.stringify(setData));
  return { set: setData, cached: false };
}
// ▲ セット取得ヘルパー

// ▼ pokeka2カテゴリ→内部カテゴリ変換 (resolveCardList専用)
// pokeka2の生データはcategoryが日本語文字列。ここに無いカテゴリが来たら
// unmappedCategoriesとして別出しし、cardListには含めない（未対応分をハノイさんに判断してもらう）
const POKEKA2_CATEGORY_MAP = {
  "ポケモン": "pokemon",
  "グッズ": "goods",
  "ポケモンのどうぐ": "tools",
  "サポート": "supporters",
  "スタジアム": "stadiums",
  "エネルギー": "energy"
};
// ▲ pokeka2カテゴリ→内部カテゴリ変換

// ▼ トレーナーズ・エネ名前照合 (resolveCardList専用)
// pokeka2はトレーナーズ・エネにsetInfo（カード番号）を持たせてくれへん（公式サイト側の仕様、
// pokeka2の抽出漏れやないことは実HTML確認済み）。代わりに画像パスから取れるsetCodeと、
// カード名の完全一致でTCGdexのセット内カードリストから照合する。
// setCodeが無い、または"ENE"（公式サイト内部の管理用フォルダ名でTCGdexには存在せんコード）の
// 場合は最初から照合を諦めてnullを返す。
async function matchTrainerOrEnergyCard(item, env) {
  if (!item.setCode || item.setCode === "ENE") return null;

  const { set } = await getSetData(env, item.setCode);
  if (!set || !Array.isArray(set.cards)) return null;

  const matches = set.cards.filter((c) => c.name === item.name);
  if (matches.length !== 1) return null;

  return matches[0].id;
}
// ▲ トレーナーズ・エネ名前照合

// ▼ pokeka2生データ→cardList変換 (resolve_cardlist専用)
// ポケモンはsetInfo→cardId変換、トレーナーズ・エネはsetCode+名前一致でTCGdex照合。
// マッチすれば確定{cardId,count}、マッチしなければ仮登録{provisional:true,tempName,count}にする。
async function resolveCardList(pokeka2Data, env) {
  const cardList = {};
  const unmappedCategories = [];

  for (const item of pokeka2Data.cards) {
    const internalCategory = POKEKA2_CATEGORY_MAP[item.category];
    if (!internalCategory) {
      unmappedCategories.push(item.category);
      continue;
    }

    if (!cardList[internalCategory]) cardList[internalCategory] = [];

    if (internalCategory === "pokemon") {
      const candidateId = convertSetInfoToCardId(item.setInfo);
      const { card } = candidateId ? await getCardData(env, candidateId) : { card: null };

      if (card) {
        cardList[internalCategory].push({ cardId: candidateId, count: item.count });
      } else {
        // 再照合用にsetInfo（元の公式カード番号表記）も保持しておく（recheck_provisionalで使用）
        cardList[internalCategory].push({ provisional: true, tempName: item.name, count: item.count, setInfo: item.setInfo || null });
      }
    } else {
      const cardId = await matchTrainerOrEnergyCard(item, env);

      if (cardId) {
        cardList[internalCategory].push({ cardId, count: item.count });
      } else {
        // 再照合用にsetCode（元の画像パス由来コード）も保持しておく（recheck_provisionalで使用）
        cardList[internalCategory].push({ provisional: true, tempName: item.name, count: item.count, setCode: item.setCode || null });
      }
    }
  }

  return { cardList, unmappedCategories: [...new Set(unmappedCategories)] };
}
// ▲ pokeka2生データ→cardList変換

// ▼ レギュレーション適合チェック (register_meta / register_mine / update_mine 共通)
// 判定フロー：
// 1. card.regulationMarkが無い（基本エネルギー等）→常時OK
// 2. regulationMarkが現行合法マーク(regulation:current:legalMarks)に含まれる→OK
// 3. 含まれない場合、カード名がホワイトリスト(regulation:{id}:legalNameWhitelist)にあれば救済OK
// 4. どちらにも当てはまらなければ違反としてviolationsに積む（1個で止めず全部まとめて返す）
const REGULATION_ID = "regulation:2026H"; // レギュ改定単位のid。命名規則は次回以降検討
const LEGAL_MARKS_KEY = "regulation:current:legalMarks";

async function validateRegulationLegality(cardList, env) {
  const legalMarksRaw = await env.KV.get(LEGAL_MARKS_KEY);
  const legalMarks = legalMarksRaw ? JSON.parse(legalMarksRaw) : [];

  const whitelistRaw = await env.KV.get(REGULATION_ID + ":legalNameWhitelist");
  const whitelist = whitelistRaw ? JSON.parse(whitelistRaw) : [];

  const violations = [];

  for (const category of CARD_LIST_CATEGORIES) {
    const entries = cardList[category];
    if (!entries) continue;

    for (const entry of entries) {
      if (entry.provisional) continue; // provisionalはcardId未確定のためレギュ判定対象外（confirmedになった時のみ判定する）

      const { card } = await getCardData(env, entry.cardId);

      if (!card) {
        violations.push({ category, cardId: entry.cardId, reason: "card_not_found" });
        continue;
      }

      const mark = card.regulationMark;
      if (!mark) continue; // 基本エネルギー等マーク非印字カードは常時合法
      if (legalMarks.includes(mark)) continue; // マークOK
      if (whitelist.includes(card.name)) continue; // 名前ベースの救済でOK

      violations.push({ category, cardId: entry.cardId, name: card.name, mark, reason: "regulation_violation" });
    }
  }

  return { valid: violations.length === 0, violations };
}
// ▲ レギュレーション適合チェック

// ▼ id連番発行 (register_meta / register_mine / copy_mine 共通)
// counter:mine / counter:meta を読んで type-XXX（3桁ゼロ埋め）を組み立てる。
// 実データと重複してたら+1してリトライし、確定した番号の次からKV上のカウンターを更新する。
async function generateId(env, type) {
  const counterKey = "counter:" + type;
  let n = parseInt((await env.KV.get(counterKey)) || "1", 10);

  let candidateId;
  let key;
  while (true) {
    candidateId = type + "-" + String(n).padStart(3, "0");
    key = "deck:" + type + ":" + candidateId;
    const existing = await env.KV.get(key);
    if (!existing) break;
    n++;
  }

  await env.KV.put(counterKey, String(n + 1));
  return candidateId;
}
// ▲ id連番発行

// ▼ コピー時自動命名 (copy_mine / copy_meta 共通) ※Windows方式「〇〇のコピー」「〇〇のコピー(2)」
// type（"mine" or "meta"）側の既存デッキ名の中で、空いてる一番若い番号を採用する（削除で空いた番号は再利用）
async function generateCopyName(env, sourceName, type) {
  const prefix = "deck:" + type + ":";
  const list = await env.KV.list({ prefix });
  const names = new Set();
  for (const k of list.keys) {
    if (k.name.slice(prefix.length).includes(":")) continue; // backupキー等は除外
    const raw = await env.KV.get(k.name);
    if (!raw) continue;
    const d = JSON.parse(raw);
    names.add(d.name);
  }

  const base = sourceName + "のコピー";
  if (!names.has(base)) return base;

  let n = 2;
  while (names.has(base + "(" + n + ")")) n++;
  return base + "(" + n + ")";
}
// ▲ コピー時自動命名

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // プリフライトリクエスト（OPTIONS）対応
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // セット一覧を保存
    if (url.searchParams.get("init") === "true") {
      const setsRes = await fetch(`${TCGDEX_BASE}/sets`);
      const sets = await setsRes.json();
      const standardSets = sets.filter(s => s.id.startsWith("SV"));
      await env.KV.put("sets:standard", JSON.stringify(standardSets));
      await env.KV.put("sync:progress", "0");
      return new Response(
        JSON.stringify({ ok: true, total: standardSets.length }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    // 1セットずつ処理
    if (url.searchParams.get("sync") === "true") {
      const setsRaw = await env.KV.get("sets:standard");
      const sets = JSON.parse(setsRaw);
      const progressRaw = await env.KV.get("sync:progress");
      const progress = parseInt(progressRaw || "0");

      if (progress >= sets.length) {
        return new Response(
          JSON.stringify({ ok: true, status: "完了！", total: sets.length }),
          { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      const set = sets[progress];
      const setRes = await fetch(`${TCGDEX_BASE}/sets/${set.id}`);
      const setData = await setRes.json();
      await env.KV.put("set:" + set.id, JSON.stringify(setData));
      await env.KV.put("sync:progress", String(progress + 1));

      return new Response(
        JSON.stringify({ ok: true, saved: set.id, progress: progress + 1, total: sets.length }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    // ▼ 環境デッキ登録 (register_meta)
    if (url.searchParams.get("register_meta") === "true") {
      if (request.method !== "POST") {
        return new Response(
          JSON.stringify({ ok: false, error: "POSTで送ってな" }),
          { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      const body = await request.json();
      const { name, cardList, howToPlay, deckCode } = body;

      if (!name || !cardList) {
        return new Response(
          JSON.stringify({ ok: false, error: "name/cardListは全部必須やで（idは自動採番されるから送らんでええ）" }),
          { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      const cardListError = validateCardList(cardList);
      if (cardListError) {
        return new Response(
          JSON.stringify({ ok: false, error: cardListError }),
          { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      applyProvisionalAwaitDefaults(cardList);

      const regulationResult = await validateRegulationLegality(cardList, env);
      if (!regulationResult.valid) {
        return new Response(
          JSON.stringify({ ok: false, error: "regulation_violation", violations: regulationResult.violations }),
          { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      const id = await generateId(env, "meta");
      const key = "deck:meta:" + id;

      await env.KV.put(key, JSON.stringify({ id, name, cardList, howToPlay: howToPlay || "", deckCode: deckCode || "" }));
      return new Response(
        JSON.stringify({ ok: true, saved: key, id }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
    // ▲ 環境デッキ登録 (register_meta)
// ▼ 環境デッキ削除 (delete_meta)
if (url.searchParams.get("delete_meta") === "true") {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POSTで送ってな" }),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const body = await request.json();
  const { id } = body;

  if (!id) {
    return new Response(
      JSON.stringify({ ok: false, error: "idは必須やで" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const key = "deck:meta:" + id;
  const existing = await env.KV.get(key);
  if (!existing) {
    return new Response(
      JSON.stringify({ ok: false, error: `id "${id}" は見つからんかったで` }),
      { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  await env.KV.delete(key);
  return new Response(
    JSON.stringify({ ok: true, deleted: key }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
// ▲ 環境デッキ削除 (delete_meta)
// ▼ 環境デッキ コピー作成 (copy_meta)
if (url.searchParams.get("copy_meta") === "true") {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POSTで送ってな" }),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const body = await request.json();
  const { sourceId } = body;

  if (!sourceId) {
    return new Response(
      JSON.stringify({ ok: false, error: "sourceIdは必須やで（newId/newNameは自動生成されるから送らんでええ）" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const sourceKey = "deck:meta:" + sourceId;
  const sourceRaw = await env.KV.get(sourceKey);
  if (!sourceRaw) {
    return new Response(
      JSON.stringify({ ok: false, error: `コピー元 "${sourceKey}" が見つからんかったで` }),
      { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const source = JSON.parse(sourceRaw);
  const newId = await generateId(env, "meta");
  const newName = await generateCopyName(env, source.name, "meta");
  const newKey = "deck:meta:" + newId;

  const newDeck = {
    id: newId,
    name: newName,
    cardList: source.cardList,
    howToPlay: source.howToPlay || "",
    deckCode: source.deckCode || ""
  };

  await env.KV.put(newKey, JSON.stringify(newDeck));
  return new Response(
    JSON.stringify({ ok: true, saved: newKey, id: newId, name: newName }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
// ▲ 環境デッキ コピー作成 (copy_meta)
// ▼ 環境デッキ 回し方メモ更新 (update_meta_howtoplay) ※howToPlayのみ書き換え、cardList等は不可
if (url.searchParams.get("update_meta_howtoplay") === "true") {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POSTで送ってな" }),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const body = await request.json();
  const { id, howToPlay } = body;

  if (!id || typeof howToPlay !== "string") {
    return new Response(
      JSON.stringify({ ok: false, error: "id・howToPlayは両方必須やで（howToPlayは文字列で）" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const key = "deck:meta:" + id;
  const raw = await env.KV.get(key);
  if (!raw) {
    return new Response(
      JSON.stringify({ ok: false, error: `"${key}" が見つからんかったで` }),
      { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const deck = JSON.parse(raw);
  deck.howToPlay = howToPlay;

  await env.KV.put(key, JSON.stringify(deck));
  return new Response(
    JSON.stringify({ ok: true, saved: key, howToPlay: deck.howToPlay }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
// ▲ 環境デッキ 回し方メモ更新 (update_meta_howtoplay)
  // ▼ 環境デッキ 回し方メモ取得 (get_meta_howtoplay) ※編集パネル表示用の単体取得
const getMetaHowToPlayId = url.searchParams.get("get_meta_howtoplay");
if (getMetaHowToPlayId) {
  const key = "deck:meta:" + getMetaHowToPlayId;
  const raw = await env.KV.get(key);
  if (!raw) {
    return new Response(
      JSON.stringify({ ok: false, error: `"${key}" が見つからんかったで` }),
      { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
  const deck = JSON.parse(raw);
  return new Response(
    JSON.stringify({ ok: true, id: deck.id, howToPlay: deck.howToPlay || "" }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
// ▲ 環境デッキ 回し方メモ取得 (get_meta_howtoplay)
// ▼ 自分のデッキ登録 (register_mine)
    if (url.searchParams.get("register_mine") === "true") {
      if (request.method !== "POST") {
        return new Response(
          JSON.stringify({ ok: false, error: "POSTで送ってな" }),
          { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      const body = await request.json();
      const { name, cardList, concern } = body;

      if (!name || !cardList) {
        return new Response(
          JSON.stringify({ ok: false, error: "name/cardListは全部必須やで（idは自動採番されるから送らんでええ）" }),
          { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      const cardListError = validateCardList(cardList);
      if (cardListError) {
        return new Response(
          JSON.stringify({ ok: false, error: cardListError }),
          { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      applyProvisionalAwaitDefaults(cardList);

      const regulationResult = await validateRegulationLegality(cardList, env);
      if (!regulationResult.valid) {
        return new Response(
          JSON.stringify({ ok: false, error: "regulation_violation", violations: regulationResult.violations }),
          { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      const id = await generateId(env, "mine");
      const key = "deck:mine:" + id;

      await env.KV.put(key, JSON.stringify({ id, name, cardList, concern: concern || "" }));
      return new Response(
        JSON.stringify({ ok: true, saved: key, id }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
    // ▲ 自分のデッキ登録 (register_mine)
// ▼ 自分のデッキ更新 (update_mine)
if (url.searchParams.get("update_mine") === "true") {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POSTで送ってな" }),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const body = await request.json();
  const { id } = body;

  if (!id) {
    return new Response(
      JSON.stringify({ ok: false, error: "idは必須やで" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const key = "deck:mine:" + id;
  const raw = await env.KV.get(key);
  if (!raw) {
    return new Response(
      JSON.stringify({ ok: false, error: `id "${id}" は見つからんかったで` }),
      { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const existing = JSON.parse(raw);
  if (existing.locked) {
    return new Response(
      JSON.stringify({ ok: false, error: `id "${id}" はロック中やから更新できへんで（unlock_mineで解除してな）` }),
      { status: 409, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  // 送られてきた項目だけ上書き（キーが存在するかどうかで判定）
  const updatable = ["name", "cardList", "concern", "deckCode", "locked"];
  const merged = { ...existing };
  for (const field of updatable) {
    if (field in body) {
      merged[field] = body[field];
    }
  }

  if ("cardList" in body) {
    const cardListError = validateCardList(merged.cardList);
    if (cardListError) {
      return new Response(
        JSON.stringify({ ok: false, error: cardListError }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    // register_meta/register_mineと同じく、update_mine経由で新しく増えたprovisionalにも
    // 初期値を埋める（既存のregisteredAtがあるものは上書きしない）。
    applyProvisionalAwaitDefaults(merged.cardList);

    const regulationResult = await validateRegulationLegality(merged.cardList, env);
    if (!regulationResult.valid) {
      return new Response(
        JSON.stringify({ ok: false, error: "regulation_violation", violations: regulationResult.violations }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
  }

  // 更新直前に1世代だけバックアップ退避
  await env.KV.put("deck:mine:backup:" + id, raw);

  await env.KV.put(key, JSON.stringify(merged));
  return new Response(
    JSON.stringify({ ok: true, updated: key }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
// ▲ 自分のデッキ更新 (update_mine)

// ▼ 自分のデッキ ロック解除 (unlock_mine)
if (url.searchParams.get("unlock_mine") === "true") {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POSTで送ってな" }),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const body = await request.json();
  const { id } = body;

  if (!id) {
    return new Response(
      JSON.stringify({ ok: false, error: "idは必須やで" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const key = "deck:mine:" + id;
  const raw = await env.KV.get(key);
  if (!raw) {
    return new Response(
      JSON.stringify({ ok: false, error: `id "${id}" は見つからんかったで` }),
      { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const existing = JSON.parse(raw);
  existing.locked = false;
  await env.KV.put(key, JSON.stringify(existing));

  return new Response(
    JSON.stringify({ ok: true, unlocked: key }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
// ▲ 自分のデッキ ロック解除 (unlock_mine)

// ▼ 自分のデッキ provisional一括再チェック (recheck_mine)
// cardList内のprovisionalエントリー（tempName＋setInfo/setCode保持分のみ）を、
// resolveCardListと同じ照合ロジックでTCGdexへ再照合。ヒットすればconfirmed（{cardId,count}）へ昇格。
// ロック中のデッキでも実行可（中身の構成・枚数は変えず、既存カードの正体確定のみのため）。
// setInfo/setCoreを持たない古いprovisional（この機能実装前に登録されたもの）は再照合できずスキップされる。
// awaitStatus:'manual'のエントリーは「待っても永久に載らない見込み」として再照合の対象外（2026-07-20設計確定分）。
if (url.searchParams.get("recheck_mine") === "true") {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POSTで送ってな" }),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const body = await request.json();
  const { id } = body;

  if (!id) {
    return new Response(
      JSON.stringify({ ok: false, error: "idは必須やで" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const key = "deck:mine:" + id;
  const raw = await env.KV.get(key);
  if (!raw) {
    return new Response(
      JSON.stringify({ ok: false, error: `id "${id}" は見つからんかったで` }),
      { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const existing = JSON.parse(raw);
  let upgraded = 0;
  let stillProvisional = 0;
  let skipped = 0; // setInfo/setCode無しで再照合しようがない古いprovisional
  let manualSkipped = 0; // awaitStatus:'manual'のため対象外にしたもの

  for (const category of CARD_LIST_CATEGORIES) {
    if (!Array.isArray(existing.cardList?.[category])) continue;

    for (let i = 0; i < existing.cardList[category].length; i++) {
      const entry = existing.cardList[category][i];
      if (entry.provisional !== true) continue;
      if (entry.awaitStatus === "manual") { manualSkipped++; continue; }

      let matchedCardId = null;

      if (category === "pokemon") {
        if (!entry.setInfo) { skipped++; continue; }
        const candidateId = convertSetInfoToCardId(entry.setInfo);
        const { card } = candidateId ? await getCardData(env, candidateId) : { card: null };
        if (card) matchedCardId = candidateId;
      } else {
        if (!entry.setCode) { skipped++; continue; }
        matchedCardId = await matchTrainerOrEnergyCard({ setCode: entry.setCode, name: entry.tempName }, env);
      }

      if (matchedCardId) {
        existing.cardList[category][i] = { cardId: matchedCardId, count: entry.count };
        upgraded++;
      } else {
        stillProvisional++;
      }
    }
  }

  if (upgraded > 0) {
    // 更新直前に1世代だけバックアップ退避（update_mineと同じ方式）
    await env.KV.put("deck:mine:backup:" + id, raw);
    await env.KV.put(key, JSON.stringify(existing));
  }

  return new Response(
    JSON.stringify({ ok: true, id, upgraded, stillProvisional, skipped, manualSkipped }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
// ▲ 自分のデッキ provisional一括再チェック (recheck_mine)

// ▼ 自分のデッキ削除 (delete_mine)
if (url.searchParams.get("delete_mine") === "true") {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POSTで送ってな" }),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const body = await request.json();
  const { id } = body;

  if (!id) {
    return new Response(
      JSON.stringify({ ok: false, error: "idは必須やで" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const key = "deck:mine:" + id;
  const existing = await env.KV.get(key);
  if (!existing) {
    return new Response(
      JSON.stringify({ ok: false, error: `id "${id}" は見つからんかったで` }),
      { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  await env.KV.delete(key);
  await env.KV.delete("deck:mine:backup:" + id); // バックアップキーがあれば一緒に消す
  return new Response(
    JSON.stringify({ ok: true, deleted: key }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
// ▲ 自分のデッキ削除 (delete_mine)

// ▼ 自分のデッキ コピー作成 (copy_mine)
if (url.searchParams.get("copy_mine") === "true") {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POSTで送ってな" }),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const body = await request.json();
  const { sourceType, sourceId } = body;

  if (!sourceType || !sourceId) {
    return new Response(
      JSON.stringify({ ok: false, error: "sourceType/sourceIdは全部必須やで（newId/newNameは自動生成されるから送らんでええ）" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  if (sourceType !== "meta" && sourceType !== "mine") {
    return new Response(
      JSON.stringify({ ok: false, error: `sourceTypeは"meta"か"mine"のどっちかにしてな` }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const sourceKey = "deck:" + sourceType + ":" + sourceId;
  const sourceRaw = await env.KV.get(sourceKey);
  if (!sourceRaw) {
    return new Response(
      JSON.stringify({ ok: false, error: `コピー元 "${sourceKey}" が見つからんかったで` }),
      { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const source = JSON.parse(sourceRaw);
  const newId = await generateId(env, "mine");
  const newName = await generateCopyName(env, source.name, "mine");
  const newKey = "deck:mine:" + newId;

  const concern = sourceType === "meta"
    ? (source.howToPlay ? `[元メタの回し方] ${source.howToPlay}` : "")
    : (source.concern || "");

  const newDeck = {
    id: newId,
    name: newName,
    cardList: source.cardList,
    concern: concern,
    deckCode: "",
    locked: false
  };

  await env.KV.put(newKey, JSON.stringify(newDeck));
  return new Response(
    JSON.stringify({ ok: true, saved: newKey, id: newId, name: newName }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
// ▲ 自分のデッキ コピー作成 (copy_mine)

    // ▼ 環境デッキ一覧 (list_meta) ※id・nameのみの軽量一覧
    if (url.searchParams.get("list_meta") === "true") {
      const list = await env.KV.list({ prefix: "deck:meta:" });
      const raws = await Promise.all(
        list.keys
          .filter((k) => !k.name.slice("deck:meta:".length).includes(":"))
          .map((k) => env.KV.get(k.name))
      );
      const decks = raws
        .filter((raw) => raw !== null) // 削除直後のKV反映ラグ対策
        .map((raw) => {
          const { id, name, deckCode } = JSON.parse(raw);
          return { id, name, deckCode: deckCode || "" };
        });
      return new Response(
        JSON.stringify({ ok: true, decks }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
    // ▲ 環境デッキ一覧 (list_meta)

    // ▼ 自分のデッキ一覧 (list_mine) ※中身込みで全部返す
    if (url.searchParams.get("list_mine") === "true") {
      const list = await env.KV.list({ prefix: "deck:mine:" });
      const raws = await Promise.all(
        list.keys
          .filter((k) => !k.name.slice("deck:mine:".length).includes(":"))
          .map((k) => env.KV.get(k.name))
      );
      const decks = raws
        .filter((raw) => raw !== null) // 削除直後のKV反映ラグ対策
        .map((raw) => JSON.parse(raw));
      return new Response(
        JSON.stringify({ ok: true, decks }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
    // ▲ 自分のデッキ一覧 (list_mine)

    // ▼ カード詳細取得 (get_card) ※遅延キャッシュ方式
    // 1. card:{cardId} を先に確認して、あればそのまま返す
    // 2. 無ければTCGdexのカード単体APIを直接叩き、結果をcard:{cardId}に保存してから返す
    const getCardId = url.searchParams.get("get_card");
    if (getCardId) {
      const { card, cached } = await getCardData(env, getCardId);
      if (!card) {
        return new Response(
          JSON.stringify({ ok: false, error: `cardId "${getCardId}" が見つからんかったで` }),
          { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }
      return new Response(
        JSON.stringify({ ok: true, cached, card }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
    // ▲ カード詳細取得 (get_card)

// ▼ setInfo→TCGdex id変換テスト (resolve_card_id) ※動作確認用、register_meta本体への組み込みは次ステップ
const resolveSetInfo = url.searchParams.get("resolve_card_id");
if (resolveSetInfo) {
  const candidateId = convertSetInfoToCardId(resolveSetInfo);

  if (!candidateId) {
    return new Response(
      JSON.stringify({ ok: false, error: "setInfoが空か形式が不正やで" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const { card, cached } = await getCardData(env, candidateId);

  return new Response(
    JSON.stringify({
      ok: true,
      setInfo: resolveSetInfo,
      candidateId,
      matched: !!card,
      cached,
      card: card || null
    }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
// ▲ setInfo→TCGdex id変換テスト (resolve_card_id)

// ▼ deckCode→cardList変換 (resolve_cardlist) ※register_metaのcardList入力フロー統合用
// deckCodeを受け取り、POKEKA2 Service Binding経由でpokeka2を呼び出して生データを取得。
// resolveCardList()でポケモンのみTCGdex照合、トレーナーズ・エネはpassthroughで仮登録にして返す。
// この時点ではKVには保存しない（register_metaへの入力材料を返すだけ）。
if (url.searchParams.get("resolve_cardlist") === "true") {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POSTで送ってな" }),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const body = await request.json();
  const { deckCode } = body;

  if (!deckCode) {
    return new Response(
      JSON.stringify({ ok: false, error: "deckCodeは必須やで" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const pokeka2Res = await env.POKEKA2.fetch(`https://pokeka2.internal/?code=${encodeURIComponent(deckCode)}`);
  if (!pokeka2Res.ok) {
    return new Response(
      JSON.stringify({ ok: false, error: `pokeka2の呼び出しに失敗したで（status: ${pokeka2Res.status}）` }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const pokeka2Data = await pokeka2Res.json();
  const { cardList, unmappedCategories } = await resolveCardList(pokeka2Data, env);

  return new Response(
    JSON.stringify({ ok: true, deckCode, cardList, unmappedCategories }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
// ▲ deckCode→cardList変換 (resolve_cardlist)

    // ▼ 新弾差分確認 (check_set) ※新弾ロード運用フローのステップ2、都度TCGdexへ直接照会（キャッシュ無し）
    if (url.searchParams.get("check_set") === "true") {
      const setsRes = await fetch(`${TCGDEX_BASE}/sets`);
      const allSets = await setsRes.json();
      const standardSets = allSets.filter(s => s.id.startsWith("SV"));

      const existingRaw = await env.KV.get("sets:standard");
      const existing = existingRaw ? JSON.parse(existingRaw) : [];
      const existingIds = new Set(existing.map(s => s.id));

      const newSets = standardSets
        .filter(s => !existingIds.has(s.id))
        .map(s => ({ id: s.id, name: s.name }));

      return new Response(
        JSON.stringify({ ok: true, newSets, checkedAt: new Date().toISOString() }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
    // ▲ 新弾差分確認 (check_set)
// ▼ レギュ再チェック一括 (recheck_all) ※読み取り専用、meta/mine両方対象
if (url.searchParams.get("recheck_all") === "true") {
  const results = [];

  for (const type of ["meta", "mine"]) {
    const list = await env.KV.list({ prefix: "deck:" + type + ":" });
    const raws = await Promise.all(
      list.keys
        .filter((k) => !k.name.slice(("deck:" + type + ":").length).includes(":"))
        .map((k) => env.KV.get(k.name))
    );

    for (const raw of raws) {
      if (!raw) continue;
      const deck = JSON.parse(raw);
      const regulationResult = await validateRegulationLegality(deck.cardList, env);
      if (!regulationResult.valid) {
        results.push({ type, id: deck.id, name: deck.name, violations: regulationResult.violations });
      }
    }
  }

  return new Response(
    JSON.stringify({ ok: true, results, checkedAt: new Date().toISOString() }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
// ▲ レギュ再チェック一括 (recheck_all)
    return new Response("ok", { headers: { "Content-Type": "text/plain", ...CORS_HEADERS } });
  }
};
