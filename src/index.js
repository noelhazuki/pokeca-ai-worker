export default {
  async fetch(request, env) {
    const BASE = "https://api.tcgdex.net/v2/ja";
    const url = new URL(request.url);

    // セット一覧を保存
    if (url.searchParams.get("init") === "true") {
      const setsRes = await fetch(`${BASE}/sets`);
      const sets = await setsRes.json();
      const standardSets = sets.filter(s => s.id.startsWith("SV"));
      await env.KV.put("sets:standard", JSON.stringify(standardSets));
      await env.KV.put("sync:progress", "0");
      return new Response(
        JSON.stringify({ ok: true, total: standardSets.length }),
        { headers: { "Content-Type": "application/json" } }
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
          { headers: { "Content-Type": "application/json" } }
        );
      }

      const set = sets[progress];
      const setRes = await fetch(`${BASE}/sets/${set.id}`);
      const setData = await setRes.json();
      await env.KV.put("set:" + set.id, JSON.stringify(setData));
      await env.KV.put("sync:progress", String(progress + 1));

      return new Response(
        JSON.stringify({ ok: true, saved: set.id, progress: progress + 1, total: sets.length }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

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

    return new Response("ok", { headers: { "Content-Type": "text/plain" } });
  }
};
