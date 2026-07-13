// ▼ 環境デッキ登録 (register_meta)
if (url.searchParams.get("register_meta") === "true") {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POSTで送ってな" }),
      { status: 405, headers: { "Content-Type": "application/json" } }
    );
  }

  const body = await request.json();
  const { id, name, cardList, howToPlay } = body;

  if (!id || !name || !cardList || !howToPlay) {
    return new Response(
      JSON.stringify({ ok: false, error: "id/name/cardList/howToPlayは全部必須やで" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const key = "deck:meta:" + id;
  const existing = await env.KV.get(key);
  if (existing) {
    return new Response(
      JSON.stringify({ ok: false, error: `id "${id}" は既に登録済みやで` }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    );
  }

  await env.KV.put(key, JSON.stringify({ id, name, cardList, howToPlay }));
  return new Response(
    JSON.stringify({ ok: true, saved: key }),
    { headers: { "Content-Type": "application/json" } }
  );
}
// ▲ 環境デッキ登録 (register_meta)
