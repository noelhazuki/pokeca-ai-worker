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
// - pid: 2026-07-21追加。tempName＋setInfoの表記ゆれ対策で、provisionalエントリーごとに
//   デッキ内で一意な背番号（p1, p2…）を振る。カテゴリを跨いで通し番号（ポケモンのp3の次は
//   グッズでもp4、という具合）。既にpidを持つエントリー（recheck_mine後の再保存等）は
//   上書きせず、無いものだけ採番する。採番前に既存の最大番号を一度スキャンしてから
//   続き番号を割り当てるので、update_mineで後から増えたprovisionalにも重複なく振れる。
function applyProvisionalAwaitDefaults(cardList) {
  const now = new Date().toISOString();

  let maxPid = 0;
  for (const category of CARD_LIST_CATEGORIES) {
    const entries = cardList[category];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry.provisional !== true) continue;
      if (typeof entry.pid === "string" && /^p\d+$/.test(entry.pid)) {
        const n = parseInt(entry.pid.slice(1), 10);
        if (n > maxPid) maxPid = n;
      }
    }
  }

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
      if (typeof entry.pid !== "string" || entry.pid.trim() === "") {
        maxPid += 1;
        entry.pid = `p${maxPid}`;
      }
    }
  }
  return cardList;
}
// ▲ provisional awaitStatus初期値付与

// ▼ provisional対象特定ヘルパー (set_manual / update_wait_days 共通)
// category＋tempName＋setInfoの完全一致で、cardList内から該当する1件のprovisionalエントリーを探す。
// setInfoの比較先はカテゴリによって違う点に注意：ポケモンはentry.setInfo、トレーナーズ／エネはentry.setCode。
// （呼び出し側は両方とも同じ"setInfo"という名前でリクエストを送ってくる想定。データ構造上の名前の違いはこの関数が吸収する）
// 見つからなければnullを返す。
//
// 2026-07-21追記：pid（p1,p2…の背番号）による特定ルートを追加。tempNameは人間が入力した
// テキストなので表記ゆれ（末尾スペース等）で完全一致に失敗するケースがあり、pidならその
// 心配がない。pidが渡されてきた場合はpid一致のみで特定し、tempName/setInfoは見ない
// （categoryも実質不要だが、呼び出し側の互換のため引数自体は残す）。
// pidが渡されなかった場合は、pid実装前に登録された古いprovisionalとの互換のため、
// 従来通りcategory＋tempName＋setInfoの完全一致にフォールバックする。
function findProvisionalEntry(cardList, category, tempName, setInfo, pid) {
  const entries = cardList?.[category];
  if (!Array.isArray(entries)) return null;

  if (pid) {
    return entries.find((entry) => entry.provisional === true && entry.pid === pid) || null;
  }

  return entries.find((entry) => {
    if (entry.provisional !== true) return false;
    if (entry.tempName !== tempName) return false;
    const compareField = category === "pokemon" ? entry.setInfo : entry.setCode;
    return compareField === setInfo;
  }) || null;
}
// ▲ provisional対象特定ヘルパー

// ▼ 既知手動判定setCode (register_known_manual_setcode / resolve_cardlist / recheck_mine 共通)
// プロモ等、TCGdexに恒久的に載らへんと人間が一度判断したsetCode（ポケモンはsetInfoの
// 前半部分＝スペースより前、トレーナーズ・エネはsetCodeそのもの）を覚えておくためのKV。
// 一度登録しておけば、次回以降のresolve_cardlist・recheck_mineで自動的にawaitStatus:'manual'扱いになる。
// 値は { [setCode]: "覚えとく理由メモ" } の形。
const KNOWN_MANUAL_SETCODES_KEY = "provisional:knownManualSetCodes";

async function getKnownManualSetCodes(env) {
  const raw = await env.KV.get(KNOWN_MANUAL_SETCODES_KEY);
  return raw ? JSON.parse(raw) : {};
}

// item（pokeka2生データの1件）から判定用のsetCodeを取り出す。
// ポケモンはsetInfo「SV11W 043/086」の前半（スペースより前）、トレーナーズ・エネはsetCodeそのもの。
function extractSetCodeForKnownList(category, item) {
  if (category === "pokemon") {
    return typeof item.setInfo === "string" ? item.setInfo.split(" ")[0] : null;
  }
  return item.setCode || null;
}
// ▲ 既知手動判定setCode

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
  "エネルギー": "energy", // 旧カテゴリ値。pokeka2側の分割後は基本的に来ないはずだが後方互換のため残す
  "基本エネルギー": "energy", // 2026-07-21〜：pokeka2側でエネルギーが基本/特殊に分割されたことに対応
  "特殊エネルギー": "energy", // cardList側では基本/特殊とも同じenergyカテゴリに統合したまま。区別はvalidateDeckRules内でTCGdexのenergyTypeを都度参照する方式で2026-07-22実装済み
  "ACE SPEC": "aceSpec" // 2026-07-21〜：pokeka2側で名前の"(ACE SPEC)"注記から検出しcategoryを上書きする方式に対応
};
// ▲ pokeka2カテゴリ→内部カテゴリ変換

// ▼ トレーナーズ・エネ名前照合 (resolveCardList専用)
// pokeka2はトレーナーズ・エネにsetInfo（カード番号）を持たせてくれへん（公式サイト側の仕様、
// pokeka2の抽出漏れやないことは実HTML確認済み）。代わりに画像パスから取れるsetCodeと、
// カード名の完全一致でTCGdexのセット内カードリストから照合する。
// setCodeが無い、または"ENE"（公式サイト内部の管理用フォルダ名でTCGdexには存在せんコード）の
// 場合は最初から照合を諦めてnullを返す。
//
// 2026-07-21追記：同一setCode内に同名カードの型番違いが複数存在するケースが実在すると判明
// （例：ボスの指令 724/742・760/742、ポケパッド 070/080・103/080）。この場合は従来
// 「複数ヒット＝諦めてnull」としていたが、それだとMC/M3のように常にprovisionalへ落ちて
// 確定させる手段がなかった。決定事項として「型番(localId)が最小のものを機械的に採用」する
// ルールを追加した。型番最小＝必ず「正しいカード」という保証ではない（割り切りルール）。
function pickSmallestLocalIdCard(matches) {
  return matches.reduce((smallest, current) => {
    const smallestNum = parseInt(smallest.localId, 10);
    const currentNum = parseInt(current.localId, 10);
    return currentNum < smallestNum ? current : smallest;
  });
}

async function matchTrainerOrEnergyCard(item, env) {
  if (!item.setCode || item.setCode === "ENE") return null;

  const { set } = await getSetData(env, item.setCode);
  if (!set || !Array.isArray(set.cards)) return null;

  const matches = set.cards.filter((c) => c.name === item.name);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].id;

  // 複数ヒット時：型番(localId)最小のものを採用
  return pickSmallestLocalIdCard(matches).id;
}
// ▲ トレーナーズ・エネ名前照合

// ▼ pokeka2生データ→cardList変換 (resolve_cardlist専用)
// ポケモンはsetInfo→cardId変換、トレーナーズ・エネはsetCode+名前一致でTCGdex照合。
// マッチすれば確定{cardId,count}、マッチしなければ仮登録{provisional:true,tempName,count}にする。
async function resolveCardList(pokeka2Data, env) {
  const cardList = {};
  const unmappedCategories = [];
  const knownManualSetCodes = await getKnownManualSetCodes(env);

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
        const entry = { provisional: true, tempName: item.name, count: item.count, setInfo: item.setInfo || null };
        // 既知の「恒久的にTCGdex未収録」setCode（プロモ等）なら、最初からmanual扱いにする
        const knownCode = extractSetCodeForKnownList("pokemon", item);
        if (knownCode && knownManualSetCodes[knownCode]) entry.awaitStatus = "manual";
        cardList[internalCategory].push(entry);
      }
    } else {
      const cardId = await matchTrainerOrEnergyCard(item, env);

      if (cardId) {
        cardList[internalCategory].push({ cardId, count: item.count });
      } else {
        // 再照合用にsetCode（元の画像パス由来コード）も保持しておく（recheck_provisionalで使用）
        const entry = { provisional: true, tempName: item.name, count: item.count, setCode: item.setCode || null };
        const knownCode = extractSetCodeForKnownList(internalCategory, item);
        if (knownCode && knownManualSetCodes[knownCode]) entry.awaitStatus = "manual";
        cardList[internalCategory].push(entry);
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

// ▼ deckRules判定 (register_meta / register_mine / update_mine 共通)
// 2026-07-21設計確定：MTGA方式（違反があっても登録・保存はブロックしない。警告として返すのみ）。
// これに合わせて、上のvalidateRegulationLegalityの呼び出し側（register_meta/register_mine/update_mine）も
// 同日、400ブロック方式からMTGA方式（登録は通し、violationsは警告として返すだけ）に変更した。
//
// 実装範囲（2026-07-22時点）：5ルール全て実装済み（同名4枚まで／60枚ちょうど／ACE SPEC合計1枚まで／
// 基本エネルギー無制限／たね最低1体）。isBasicEnergy・isAceSpecという専用の中間フィールドは
// 結局OCR共通スキーマ側に新設せず、判定のたびにTCGdexカードデータ（energyType/stage/trainerType）を
// getCardData()経由で直接参照する方式で決着した（cross_category_fields構想からの方針変更、下記参照）。
//
// ACE SPEC判定の設計メモ（2026-07-22決定）：
// resolve_cardlist経由の登録は、pokeka2側で名前の"(ACE SPEC)"注記を検出した時点で
// 既にcardList.aceSpecカテゴリへ振り分け済み（POKEKA2_CATEGORY_MAP参照）。そのため
// 「goods/tools/supporters/stadiumsに紛れ込んだACE SPECカードもTCGdexのtrainerTypeで
// 拾いにいく」という厳密案（B案）は採用せず、aceSpecカテゴリの合計countのみで判定するA案を採用した。
// 手動でcardListを直接組み立てて登録する場合（resolve_cardlist経由でない場合）、ACE SPECカードを
// 誤って別カテゴリに置くとこの判定は効かない点に注意（運用上ほぼresolve_cardlist経由のため許容）。
//
// 返り値の形（deckRuleViolations、既存のviolationsとは別物）：
// ・デッキ全体用：{ reason: "total_count" | "no_basic_pokemon", count, expected }
// ・カード単位用：{ reason: "same_name_over_limit", name, count, limit }
// ・合計超過用：{ reason: "ace_spec_over_limit", total, limit, cards }
async function validateDeckRules(cardList, env) {
  const deckRuleViolations = [];

  // ① デッキ合計60枚ちょうど
  let totalCount = 0;
  for (const category of CARD_LIST_CATEGORIES) {
    const entries = cardList[category];
    if (!entries) continue;
    for (const entry of entries) {
      totalCount += entry.count;
    }
  }
  if (totalCount !== 60) {
    deckRuleViolations.push({ reason: "total_count", count: totalCount, expected: 60 });
  }

  // energyカテゴリの各エントリーについて、先に基本エネルギーかどうか（isBasicEnergy相当）を判定しておく。
  // TCGdexのenergyType:"Normal"が基本エネルギー、それ以外（"Special"等）が特殊エネルギー。
  // provisional（cardId未確定）は正体不明なので基本エネルギー扱いにはしない＝安全側（4枚チェック対象に残す）。
  const energyEntries = cardList.energy || [];
  const energyIsBasicFlags = [];
  for (const entry of energyEntries) {
    if (entry.provisional) {
      energyIsBasicFlags.push(false);
      continue;
    }
    const { card } = await getCardData(env, entry.cardId);
    energyIsBasicFlags.push(!!(card && card.energyType === "Normal"));
  }

  // ② 同名カード基本4枚まで（名前基準で合算）
  // 2026-07-22〜：energyカテゴリも対象に含める。ただし基本エネルギー（上で判定済み）は
  // 「基本エネルギー無制限」ルール対象のため、名前集計そのものから除外する。
  const nameCountMap = new Map(); // name -> 合計count

  for (const category of CARD_LIST_CATEGORIES) {
    const entries = cardList[category];
    if (!entries) continue;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (category === "energy" && energyIsBasicFlags[i]) continue; // 基本エネルギーは無制限、ここでは数えない

      let name;
      if (entry.provisional) {
        name = entry.tempName;
      } else {
        const { card } = await getCardData(env, entry.cardId);
        name = card ? card.name : entry.cardId; // 取得失敗時はcardIdで代用（card_not_foundはレギュ判定側で別途拾われる）
      }
      nameCountMap.set(name, (nameCountMap.get(name) || 0) + entry.count);
    }
  }

  for (const [name, count] of nameCountMap.entries()) {
    if (count > 4) {
      deckRuleViolations.push({ reason: "same_name_over_limit", name, count, limit: 4 });
    }
  }

  // ③ ACE SPEC合計1枚まで（A案：cardList.aceSpecカテゴリの合計countのみで判定。設計メモは関数冒頭コメント参照）
  const aceSpecEntries = cardList.aceSpec || [];
  let aceSpecTotal = 0;
  const aceSpecNames = [];
  for (const entry of aceSpecEntries) {
    aceSpecTotal += entry.count;
    if (entry.provisional) {
      aceSpecNames.push(entry.tempName);
    } else {
      const { card } = await getCardData(env, entry.cardId);
      aceSpecNames.push(card ? card.name : entry.cardId);
    }
  }
  if (aceSpecTotal > 1) {
    deckRuleViolations.push({ reason: "ace_spec_over_limit", total: aceSpecTotal, limit: 1, cards: aceSpecNames });
  }

  // ④ たね（Basic）ポケモン最低1体
  // TCGdexのstage:"Basic"がたね相当。provisional（cardId未確定）はstage判定できひんため対象外
  // （数えない＝厳しめに倒す。confirmed化してから正しく判定される）。
  const pokemonEntries = cardList.pokemon || [];
  let basicCount = 0;
  for (const entry of pokemonEntries) {
    if (entry.provisional) continue;
    const { card } = await getCardData(env, entry.cardId);
    if (card && card.stage === "Basic") {
      basicCount += entry.count;
    }
  }
  if (basicCount < 1) {
    deckRuleViolations.push({ reason: "no_basic_pokemon", count: basicCount, expected: 1 });
  }

  return deckRuleViolations;
}
// ▲ deckRules判定

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

// ▼ ask用ヘルパー：cardList → カード名の一覧テキスト化
// 既存get_cardにcardId全件をそのまま回す素直な方式（大半KVヒットのためコスト影響小）
// provisionalカード（cardId未確定）はtempNameをそのまま使う
async function buildCardListSummary(cardList, env) {
  const lines = [];
  for (const category of CARD_LIST_CATEGORIES) {
    const items = cardList[category];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item.cardId) {
        const { card } = await getCardData(env, item.cardId);
        const name = card ? card.name : item.cardId;
        lines.push(`${name} ×${item.count}`);
      } else if (item.tempName) {
        lines.push(`${item.tempName} ×${item.count}（未確定カード）`);
      }
    }
  }
  return lines;
}
// ▲ cardList → カード名の一覧テキスト化

// ▼ ask用ヘルパー：Claude API呼び出し
// レスポンスはJSON構造化{answer, newConcerns}で受け取る方式に確定（2026-07-22）。
// newConcernsの抽出は別ロジックを作らず、AI自身に構造化出力させる。
async function callAskClaude(env, { deckName, cardListSummary, openConcerns, question }) {
  const systemPrompt = `あなたはポケモンカードゲームのデッキ構築アドバイザーです。
以下のデッキ内容とこれまでの未解決の懸念点を踏まえて、ユーザーの質問に答えてください。

# デッキ名
${deckName}

# デッキの中身
${cardListSummary.join("\n")}

# これまでの未解決の懸念点
${openConcerns.length ? openConcerns.join("\n") : "（なし）"}

# 出力形式
必ず以下のJSON形式のみで出力すること。前置き・説明・Markdownのコードブロック記号は一切付けないでください。
{"answer": "質問への回答文", "newConcerns": ["今回の回答の中で新たに気づいた未解決の懸念点。無ければ空配列"]}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: question }]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API呼び出し失敗（${res.status}）: ${errText}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  const rawText = textBlock ? textBlock.text : "";

  // JSONパース失敗時のフォールバック：素の文章をそのままanswerとして返す（newConcernsは空扱い）
  try {
    const parsed = JSON.parse(rawText.trim());
    return {
      answer: parsed.answer || rawText,
      newConcerns: Array.isArray(parsed.newConcerns) ? parsed.newConcerns : []
    };
  } catch (e) {
    return { answer: rawText, newConcerns: [] };
  }
}
// ▲ Claude API呼び出し

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

      // 2026-07-21〜：MTGA方式に変更。違反があっても登録・保存はブロックせず、
      // violations / deckRuleViolationsを警告として一緒に返すのみ（以前は400で弾いていた）。
      const regulationResult = await validateRegulationLegality(cardList, env);
      const deckRuleViolations = await validateDeckRules(cardList, env);

      const id = await generateId(env, "meta");
      const key = "deck:meta:" + id;

      await env.KV.put(key, JSON.stringify({ id, name, cardList, howToPlay: howToPlay || "", deckCode: deckCode || "" }));
      return new Response(
        JSON.stringify({
          ok: true,
          saved: key,
          id,
          violations: regulationResult.violations,
          deckRuleViolations
        }),
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

      // 2026-07-21〜：MTGA方式に変更。違反があっても登録・保存はブロックせず、
      // violations / deckRuleViolationsを警告として一緒に返すのみ（以前は400で弾いていた）。
      const regulationResult = await validateRegulationLegality(cardList, env);
      const deckRuleViolations = await validateDeckRules(cardList, env);

      const id = await generateId(env, "mine");
      const key = "deck:mine:" + id;

      await env.KV.put(key, JSON.stringify({ id, name, cardList, concern: concern || "" }));
      return new Response(
        JSON.stringify({
          ok: true,
          saved: key,
          id,
          violations: regulationResult.violations,
          deckRuleViolations
        }),
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

  let violations = [];
  let deckRuleViolations = [];

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

    // 2026-07-21〜：MTGA方式に変更。違反があっても更新・保存はブロックせず、
    // violations / deckRuleViolationsを警告として一緒に返すのみ（以前は400で弾いていた）。
    const regulationResult = await validateRegulationLegality(merged.cardList, env);
    violations = regulationResult.violations;
    deckRuleViolations = await validateDeckRules(merged.cardList, env);
  }

  // 更新直前に1世代だけバックアップ退避
  await env.KV.put("deck:mine:backup:" + id, raw);

  await env.KV.put(key, JSON.stringify(merged));
  return new Response(
    JSON.stringify({ ok: true, updated: key, violations, deckRuleViolations }),
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
  const knownManualSetCodes = await getKnownManualSetCodes(env);
  let upgraded = 0;
  let stillProvisional = 0;
  let skipped = 0; // setInfo/setCode無しで再照合しようがない古いprovisional
  let manualSkipped = 0; // awaitStatus:'manual'のため対象外にしたもの
  let autoManual = 0; // 既知manual setCodeに該当したため、TCGdexに問い合わせずmanualへ切替したもの

  for (const category of CARD_LIST_CATEGORIES) {
    if (!Array.isArray(existing.cardList?.[category])) continue;

    for (let i = 0; i < existing.cardList[category].length; i++) {
      const entry = existing.cardList[category][i];
      if (entry.provisional !== true) continue;
      if (entry.awaitStatus === "manual") { manualSkipped++; continue; }

      // 既知の「恒久的にTCGdex未収録」setCodeに該当するなら、TCGdexへ問い合わせるまでもなくmanualへ切替
      const knownCode = category === "pokemon"
        ? (typeof entry.setInfo === "string" ? entry.setInfo.split(" ")[0] : null)
        : entry.setCode;
      if (knownCode && knownManualSetCodes[knownCode]) {
        entry.awaitStatus = "manual";
        autoManual++;
        continue;
      }

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

  if (upgraded > 0 || autoManual > 0) {
    // 更新直前に1世代だけバックアップ退避（update_mineと同じ方式）
    await env.KV.put("deck:mine:backup:" + id, raw);
    await env.KV.put(key, JSON.stringify(existing));
  }

  return new Response(
    JSON.stringify({ ok: true, id, upgraded, stillProvisional, skipped, manualSkipped, autoManual }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
// ▲ 自分のデッキ provisional一括再チェック (recheck_mine)

// ▼ 自分のデッキ provisional manual切替 (set_manual)
// 1件のprovisionalエントリーを、人間が個別に見て「これは実質TCGdexに載らんやつやな」と
// 判断した時に、awaitStatusを手動で'manual'へ切り替えるための専用エンドポイント（2026-07-21新設）。
// recheck_mineと同じ理屈で、ロック中のデッキでも実行可（枚数・構成は変えず状態フラグのみの更新のため）。
// 対象特定はpid（背番号）優先、無ければcategory＋tempName＋setInfoの完全一致（findProvisionalEntry参照）。
// waitDays自体はここでは変更しない（延長したい場合は update_wait_days を別途呼ぶ）。
//
// 2026-07-21追記：pidを任意項目として追加。pidを渡す場合はtempName/setInfoは省略可（categoryは
// deck:mine内のカテゴリ配列を特定するため引き続き必須）。pidを渡さない場合は従来通り
// tempName/setInfo必須（pid実装前の古いprovisional向けの経路として残す）。
if (url.searchParams.get("set_manual") === "true") {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POSTで送ってな" }),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const body = await request.json();
  const { deckId, category, tempName, setInfo, pid } = body;

  if (!deckId || !category) {
    return new Response(
      JSON.stringify({ ok: false, error: "deckId/categoryは必須やで" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
  if (!pid && (!tempName || !setInfo)) {
    return new Response(
      JSON.stringify({ ok: false, error: "pidを渡さない場合はtempName/setInfoも必須やで" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
  if (!CARD_LIST_CATEGORIES.includes(category)) {
    return new Response(
      JSON.stringify({ ok: false, error: `categoryが不正やで（許可カテゴリ: ${CARD_LIST_CATEGORIES.join(", ")}）` }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const key = "deck:mine:" + deckId;
  const raw = await env.KV.get(key);
  if (!raw) {
    return new Response(
      JSON.stringify({ ok: false, error: `deckId "${deckId}" は見つからんかったで` }),
      { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const existing = JSON.parse(raw);
  const target = findProvisionalEntry(existing.cardList, category, tempName, setInfo, pid);
  if (!target) {
    return new Response(
      JSON.stringify({ ok: false, error: "該当するprovisionalエントリーが見つからんかったで（pid、またはcategory/tempName/setInfoを確認してな）" }),
      { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  target.awaitStatus = "manual";
  await env.KV.put(key, JSON.stringify(existing));

  return new Response(
    JSON.stringify({ ok: true, deckId, category, pid: target.pid, tempName: target.tempName, awaitStatus: "manual" }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
// ▲ 自分のデッキ provisional manual切替 (set_manual)

// ▼ 自分のデッキ provisional waitDays延長 (update_wait_days)
// 1件のprovisionalエントリーのwaitDaysを上書きする専用エンドポイント（2026-07-21新設）。
// 絶対値方式：UI側の見た目が「+7」ボタンでも、内部へ送信する時点で計算済みの絶対値にしてから渡す想定
// （このエンドポイント自体は足し算をせず、送られてきた値でそのまま上書きするだけ）。
// recheck_mineと同じ理屈で、ロック中のデッキでも実行可。対象特定はset_manualと同じくfindProvisionalEntry
// （pid優先、無ければcategory＋tempName＋setInfo。2026-07-21追記：pid経路を追加）。
if (url.searchParams.get("update_wait_days") === "true") {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POSTで送ってな" }),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const body = await request.json();
  const { deckId, category, tempName, setInfo, waitDays, pid } = body;

  if (!deckId || !category) {
    return new Response(
      JSON.stringify({ ok: false, error: "deckId/categoryは必須やで" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
  if (!pid && (!tempName || !setInfo)) {
    return new Response(
      JSON.stringify({ ok: false, error: "pidを渡さない場合はtempName/setInfoも必須やで" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
  if (!CARD_LIST_CATEGORIES.includes(category)) {
    return new Response(
      JSON.stringify({ ok: false, error: `categoryが不正やで（許可カテゴリ: ${CARD_LIST_CATEGORIES.join(", ")}）` }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
  if (typeof waitDays !== "number" || !Number.isInteger(waitDays) || waitDays < 1) {
    return new Response(
      JSON.stringify({ ok: false, error: "waitDaysは1以上の整数（絶対値）で送ってな" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const key = "deck:mine:" + deckId;
  const raw = await env.KV.get(key);
  if (!raw) {
    return new Response(
      JSON.stringify({ ok: false, error: `deckId "${deckId}" は見つからんかったで` }),
      { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const existing = JSON.parse(raw);
  const target = findProvisionalEntry(existing.cardList, category, tempName, setInfo, pid);
  if (!target) {
    return new Response(
      JSON.stringify({ ok: false, error: "該当するprovisionalエントリーが見つからんかったで（pid、またはcategory/tempName/setInfoを確認してな）" }),
      { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  target.waitDays = waitDays;
  await env.KV.put(key, JSON.stringify(existing));

  return new Response(
    JSON.stringify({ ok: true, deckId, category, pid: target.pid, tempName: target.tempName, waitDays }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
// ▲ 自分のデッキ provisional waitDays延長 (update_wait_days)

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

// ▼ 既知手動判定setCodeの登録・一覧・削除 (register_known_manual_setcode / list_known_manual_setcodes / delete_known_manual_setcode)
// 2026-07-20設計確定分。プロモ等、TCGdexに恒久的に載らへんと一度人間が判断したsetCodeを
// KVへ覚えさせておくエンドポイント。登録後はresolve_cardlist・recheck_mineの両方で自動反映される。
if (url.searchParams.get("register_known_manual_setcode") === "true") {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POSTで送ってな" }),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const body = await request.json();
  const { setCode, reason } = body;

  if (!setCode || typeof setCode !== "string") {
    return new Response(
      JSON.stringify({ ok: false, error: "setCode（文字列）は必須やで" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const known = await getKnownManualSetCodes(env);
  known[setCode] = typeof reason === "string" ? reason : "";
  await env.KV.put(KNOWN_MANUAL_SETCODES_KEY, JSON.stringify(known));

  return new Response(
    JSON.stringify({ ok: true, setCode, known }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}

if (url.searchParams.get("list_known_manual_setcodes") === "true") {
  const known = await getKnownManualSetCodes(env);
  return new Response(
    JSON.stringify({ ok: true, known }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}

if (url.searchParams.get("delete_known_manual_setcode") === "true") {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POSTで送ってな" }),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const body = await request.json();
  const { setCode } = body;

  if (!setCode || typeof setCode !== "string") {
    return new Response(
      JSON.stringify({ ok: false, error: "setCode（文字列）は必須やで" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const known = await getKnownManualSetCodes(env);
  delete known[setCode];
  await env.KV.put(KNOWN_MANUAL_SETCODES_KEY, JSON.stringify(known));

  return new Response(
    JSON.stringify({ ok: true, deleted: setCode, known }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
// ▲ 既知手動判定setCodeの登録・一覧

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

// ▼ デッキ構築相談 (ask) - 2026-07-22実装
if (url.searchParams.get("ask") === "true") {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POSTで送ってな" }),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const body = await request.json();
  const { deckId, question } = body;

  if (!deckId || !question) {
    return new Response(
      JSON.stringify({ ok: false, error: "deckId/questionは両方必須やで" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const key = "deck:mine:" + deckId;
  const raw = await env.KV.get(key);
  if (!raw) {
    return new Response(
      JSON.stringify({ ok: false, error: `deckId "${deckId}" は見つからんかったで` }),
      { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const deck = JSON.parse(raw);
  const openConcerns = deck.openConcerns || [];

  try {
    const cardListSummary = await buildCardListSummary(deck.cardList, env);
    const claudeResult = await callAskClaude(env, {
      deckName: deck.name,
      cardListSummary,
      openConcerns,
      question
    });

    const updatedConcerns = [...openConcerns, ...claudeResult.newConcerns];
    await env.KV.put(key, JSON.stringify({ ...deck, openConcerns: updatedConcerns }));

    return new Response(
      JSON.stringify({ ok: true, answer: claudeResult.answer, newConcerns: claudeResult.newConcerns }),
      { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: "Claude APIとのやりとりでエラーが出たで: " + e.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
}
// ▲ デッキ構築相談 (ask)

    return new Response("ok", { headers: { "Content-Type": "text/plain", ...CORS_HEADERS } });
  }
};
