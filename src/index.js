const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

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
        return `cardList.${category}の要素は { cardId, count } の形にしてな`;
      }
      if (typeof entry.cardId !== "string" || entry.cardId.trim() === "") {
        return `cardList.${category}にcardId（文字列）が無い要素があるで`;
      }
      if (typeof entry.count !== "number" || !Number.isInteger(entry.count) || entry.count < 1) {
        return `cardList.${category}のcountは1以上の整数にしてな（cardId: ${entry.cardId}）`;
      }
    }
  }

  return null; // 問題なし
}
// ▲ cardList検証 (register_meta / register_mine 共通)

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

// ▼ コピー時自動命名 (copy_mine専用) ※Windows方式「〇〇のコピー」「〇〇のコピー(2)」
// mine側の既存デッキ名の中で、空いてる一番若い番号を採用する（削除で空いた番号は再利用）
async function generateCopyName(env, sourceName) {
  const list = await env.KV.list({ prefix: "deck:mine:" });
  const names = new Set();
  for (const k of list.keys) {
    if (k.name.slice("deck:mine:".length).includes(":")) continue; // backupキー等は除外
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
    const BASE = "https://api.tcgdex.net/v2/ja";
    const url = new URL(request.url);

    // プリフライトリクエスト（OPTIONS）対応
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // セット一覧を保存
    if (url.searchParams.get("init") === "true") {
      const setsRes = await fetch(`${BASE}/sets`);
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
      const setRes = await fetch(`${BASE}/sets/${set.id}`);
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
      const { name, cardList, howToPlay } = body;

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

      const id = await generateId(env, "meta");
      const key = "deck:meta:" + id;

      await env.KV.put(key, JSON.stringify({ id, name, cardList, howToPlay: howToPlay || "" }));
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
  const newName = await generateCopyName(env, source.name);
  const newKey = "deck:mine:" + newId;

  const newDeck = {
    id: newId,
    name: newName,
    cardList: source.cardList,
    concern: source.concern || "",
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
      const decks = await Promise.all(
        list.keys
          .filter((k) => !k.name.slice("deck:meta:".length).includes(":"))
          .map(async (k) => {
          const raw = await env.KV.get(k.name);
          const { id, name } = JSON.parse(raw);
          return { id, name };
        })
      );
      return new Response(
        JSON.stringify({ ok: true, decks }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
    // ▲ 環境デッキ一覧 (list_meta)

    // ▼ 自分のデッキ一覧 (list_mine) ※中身込みで全部返す
    if (url.searchParams.get("list_mine") === "true") {
      const list = await env.KV.list({ prefix: "deck:mine:" });
      const decks = await Promise.all(
        list.keys
          .filter((k) => !k.name.slice("deck:mine:".length).includes(":"))
          .map(async (k) => {
          const raw = await env.KV.get(k.name);
          return JSON.parse(raw);
        })
      );
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
      const cacheKey = "card:" + getCardId;
      const cached = await env.KV.get(cacheKey);
      if (cached) {
        return new Response(
          JSON.stringify({ ok: true, cached: true, card: JSON.parse(cached) }),
          { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      const cardRes = await fetch(`${BASE}/cards/${getCardId}`);
      if (!cardRes.ok) {
        return new Response(
          JSON.stringify({ ok: false, error: `cardId "${getCardId}" が見つからんかったで` }),
          { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      const cardData = await cardRes.json();
      await env.KV.put(cacheKey, JSON.stringify(cardData));
      return new Response(
        JSON.stringify({ ok: true, cached: false, card: cardData }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
    // ▲ カード詳細取得 (get_card)

    return new Response("ok", { headers: { "Content-Type": "text/plain", ...CORS_HEADERS } });
  }
};
