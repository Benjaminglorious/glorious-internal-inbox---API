/**
 * 公司郵箱入庫兩類信：
 * 1. 主旨有公司法定英文名（Glorious Motors Ltd / Limited，大小寫、標點、空白唔計）。
 *    主旨中咗就夠，正文唔使係車。
 * 2. 主旨冇公司名，但主旨或者正文新寫嘅部分（唔計 > 引用）明顯同車有關。
 * 兩樣都唔係就唔入。電子報、社交通知、驗證碼、收據、廣告、銀行／Meta、內部 IT
 * 只會擋第 2 類。已開住嘅同一電郵對話，後續短覆由入庫層決定。
 *
 * 工作人員要對照嘅規則就係呢個檔。README「公司電郵」一節係同一套說話。
 */

export interface ClassifyEmailInput {
  fromAddress: string;
  subject?: string | null;
  text?: string | null;
  listUnsubscribe?: boolean;
  autoSubmitted?: boolean;
  bulk?: boolean;
}

export interface EmailClassification {
  ingest: boolean;
  /** true 就連已開住嘅對話都唔好附加。 */
  hardReject: boolean;
  reason: string;
  vehicleRef: string | null;
}

const BLOCKED_DOMAINS = [
  "facebookmail.com",
  "facebook.com",
  "fb.com",
  "meta.com",
  "instagram.com",
  "threads.net",
  "whatsapp.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "accounts.google.com",
  "google.com",
  "paypal.com",
  "apple.com",
  "github.com",
  "microsoft.com",
  "office.com",
  "office365.com",
  "render.com",
  "hsbc.com",
  "hsbc.com.hk",
  "hangseng.com",
  "bochk.com",
  "citibank.com",
  "citibank.com.hk",
  "sc.com",
  "standardchartered.com",
  "dbs.com",
  "bankcomm.com",
  "icbc.com",
  "icbc.com.cn",
  "hkbea.com",
  "ncb.com.hk",
  "ocbc.com",
];

const BLOCKED_LOCAL =
  /^(no-?reply|notifications?|newsletter|news|mailer-daemon|postmaster|bounce|bounces|donotreply|do-not-reply|alert|alerts|notify)$/;

/** 呢啲本身就當係車，唔使再加「報價」。 */
const STRONG_PHRASES = [
  "買車",
  "賣車",
  "卖车",
  "放售",
  "求購",
  "求购",
  "收車",
  "收车",
  "睇車",
  "睇车",
  "試車",
  "试车",
  "訂車",
  "订车",
  "車盤",
  "车盘",
  "放盤",
  "放盘",
  "現貨",
  "现货",
  "車牌",
  "车牌",
  "供車",
  "供车",
  "以舊換新",
  "以旧换新",
  "換車",
  "换车",
  "七人車",
  "七人车",
  "房車",
  "房车",
  "客貨車",
  "客货车",
  "二手車",
  "二手车",
  "新車",
  "新车",
  "電動車",
  "电动车",
  "test drive",
  "test-drive",
  "trade-in",
  "trade in",
  "car for sale",
  "vehicle for sale",
];

/** 要同時見到車／vehicle，先至當係查車，避免「報價」兩個字就入庫。 */
const DEAL_WORDS = [
  "報價",
  "报价",
  "查詢",
  "查询",
  "想問",
  "想问",
  "請問",
  "请问",
  "quote",
  "quotation",
  "inquiry",
  "enquiry",
  "buy",
  "sell",
  "purchase",
  "預約",
  "预约",
  "貸款",
  "贷款",
  "分期",
  "供款",
  "finance",
  "financing",
  "現車",
  "现车",
  "有貨",
  "有货",
  "訂金",
  "订金",
];

/** 長嘅先配，避免短字蓋過。 */
const MODELS = [
  "rolls-royce",
  "rolls royce",
  "range rover",
  "land rover",
  "land cruiser",
  "lamborghini",
  "volkswagen",
  "mclaren",
  "mercedes",
  "ferrari",
  "porsche",
  "maserati",
  "bentley",
  "alphard",
  "vellfire",
  "previa",
  "estima",
  "granvia",
  "harrier",
  "fortuner",
  "coaster",
  "panamera",
  "cullinan",
  "aventador",
  "huracan",
  "cayenne",
  "toyota",
  "honda",
  "lexus",
  "nissan",
  "mazda",
  "hyundai",
  "jaguar",
  "tesla",
  "volvo",
  "audi",
  "hiace",
  "prado",
  "camry",
  "civic",
  "accord",
  "noah",
  "voxy",
  "esquire",
  "rav4",
  "macan",
  "urus",
  "benz",
  "bmw",
  "kia",
  "720s",
  "g-wagon",
  "g wagon",
  "g63",
  "i8",
  "x5",
  "x6",
  "x7",
  "埃爾法",
  "埃尔法",
  "林寶堅尼",
  "兰博基尼",
  "勞斯萊斯",
  "劳斯莱斯",
  "雷克薩斯",
  "雷克萨斯",
  "瑪莎拉蒂",
  "玛莎拉蒂",
  "保時捷",
  "保时捷",
  "麥拿倫",
  "迈凯伦",
  "凱美瑞",
  "凯美瑞",
  "沃爾沃",
  "沃尔沃",
  "法拉利",
  "萬事得",
  "马自达",
  "賓士",
  "宾士",
  "奔馳",
  "奔驰",
  "特斯拉",
  "海獅",
  "海狮",
  "考斯特",
  "普拉多",
  "陸巡",
  "陆巡",
  "雅閣",
  "雅阁",
  "思域",
  "豐田",
  "丰田",
  "本田",
  "寶馬",
  "宝马",
  "平治",
  "奧迪",
  "奥迪",
  "福士",
  "大眾",
  "大众",
  "現代",
  "现代",
  "起亞",
  "起亚",
  "路虎",
  "捷豹",
  "賓利",
  "宾利",
  "凌志",
  "日產",
  "日产",
  "威霆",
];

const SECURITY_RE =
  /驗證碼|验证码|一次性密|one[- ]time password|\botp\b|verification code|security code|登入碼|登录码|sign-in code|login code|password reset|reset your password|重設密碼|重设密码|忘記密碼|忘记密码|新裝置登入|新设备登录/;

const AD_RE =
  /unsubscribe|退訂|退订|此電郵為廣告|此电邮为广告|此乃廣告|此乃广告|立即選購|立即选购|限時優惠|限时优惠|%\s*off|優惠碼|优惠码/;

const RECEIPT_RE =
  /收據|收据|發票|发票|\breceipt\b|order confirmation|訂單確認|订单确认|your order|付款成功|payment received|e-statement|月結單|月结单/;

const SPAM_RE = /you(?:'ve| have) won|congratulations|中獎|中奖|claim your prize|免費禮物|免费礼物/;

const INQUIRY_RE =
  /想問|想问|請問|请问|可唔可以|可不可以|我想|我要|幫我|帮我|有興趣|有兴趣|預約|预约|i want|i would like|i'm interested|im interested|interested in|please quote|please advise|could you|can i|can you/;

const FALSE_FRIENDS =
  /停車場|停车场|車站|车站|車票|车票|車費|车费|車廂|车厢|火車|火车|地鐵|地铁|單車|单车|快車|班車|班车|巴士|的士|上車|上车|落車|下车|下車|車厘子|车厘子|車仔|车仔/g;

function fold(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function ignore(reason: string, hardReject: boolean): EmailClassification {
  return { ingest: false, hardReject, reason, vehicleRef: null };
}

/** 引用嘅舊信唔當係呢封新內容。主旨仍然另計。 */
export function unquotedEmailText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^-----Original Message-----/i.test(line.trim())) break;
    if (/^On .+wrote:\s*$/i.test(line.trim())) break;
    if (/^-{2,}\s*原始郵件\s*-{2,}/.test(line.trim())) break;
    if (/^-{2,}\s*转发邮件\s*-{2,}/.test(line.trim())) break;
    if (kept.length > 0 && /^寄件者[:：]/.test(line.trim())) break;
    if (kept.length > 0 && /^From:\s+\S/i.test(line.trim())) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function domainBlocked(domain: string): boolean {
  if (domain === "gmail.com" || domain.endsWith(".gmail.com")) return false;
  return BLOCKED_DOMAINS.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}

export function isBlockedEmailSender(address: string): boolean {
  const domain = address.split("@")[1] ?? "";
  if (!domain || domainBlocked(domain)) return true;
  const local = address.split("@")[0].split("+")[0];
  return BLOCKED_LOCAL.test(local);
}

function stripFalseFriends(text: string): string {
  return text.normalize("NFKC").replace(FALSE_FRIENDS, " ");
}

function matchModel(folded: string): string | null {
  const ordered = [...MODELS].sort((a, b) => b.length - a.length);
  for (const model of ordered) {
    const needle = fold(model);
    if (/[\u3400-\u9fff]/.test(needle)) {
      if (folded.includes(needle)) return model;
      continue;
    }
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    if (new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(folded)) return model;
  }
  return null;
}

/** 庫存編號、車型，或者寫明車牌時嘅牌號。冇就 null。 */
export function vehicleReference(text: string): string | null {
  const folded = fold(text);
  const stock = /\bs(\d{6,8})\b/.exec(folded);
  if (stock) return `s${stock[1]}`;
  const model = matchModel(folded);
  if (model) return model;
  if (/車牌|车牌|牌照|number plate|licence plate|license plate|registration mark/.test(folded)) {
    const plate = /\b([a-z]{1,2}\d{1,4})\b/i.exec(folded);
    if (plate) return plate[1].toUpperCase();
  }
  return null;
}

function hasGenericVehicleNoun(original: string): boolean {
  const stripped = stripFalseFriends(original);
  const folded = fold(stripped);
  if (/\b(cars?|vehicles?|automobiles?|suv|mpv|sedan|vans?)\b/.test(folded)) return true;
  return /[車车]/.test(stripped);
}

function hasStrongVehicleSignal(original: string): boolean {
  const stripped = stripFalseFriends(original);
  const folded = fold(stripped);
  if (vehicleReference(stripped)) return true;
  if (STRONG_PHRASES.some((phrase) => folded.includes(fold(phrase)))) return true;
  if (/28car\.com|sell_dsp\.php/.test(folded)) return true;
  if (!hasGenericVehicleNoun(original)) return false;
  return DEAL_WORDS.some((word) => folded.includes(fold(word)));
}

/**
 * 主旨係咪公司法定英文名。
 * 認 Glorious Motors Ltd 同 Glorious Motors Limited。
 * 大小寫、連續空白、逗號、句號、連字號都當同一句。
 * 淨係正文有呢個名、或者主旨只有 Glorious Motors 而冇 Ltd／Limited，都唔算。
 */
export function subjectNamesGloriousMotors(subject: string): boolean {
  const normalized = fold(subject)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /\bglorious motors (?:ltd|limited)\b/.test(normalized);
}

function isSecurityNotice(subject: string, fresh: string): boolean {
  const sub = fold(subject);
  const body = fold(fresh);
  if (SECURITY_RE.test(sub)) return true;
  return body.length > 0 && body.length <= 800 && SECURITY_RE.test(body);
}

/**
 * 公司主旨，或者明顯係車，先至入庫。
 * hardReject 嘅信就算寄件人已經有未完成對話都唔附加。公司主旨唔屬 hardReject。
 */
export function classifyCompanyEmail(input: ClassifyEmailInput): EmailClassification {
  const from = input.fromAddress.trim().toLowerCase();
  const subject = String(input.subject ?? "").replace(/\u0000/g, "").trim();
  const fresh = unquotedEmailText(String(input.text ?? "").replace(/\u0000/g, ""));
  const haystack = `${subject}\n${fresh}`.trim();
  const folded = fold(haystack);

  if (!from.includes("@")) return ignore("bad-from", true);
  if (subjectNamesGloriousMotors(subject)) {
    return {
      ingest: true,
      hardReject: false,
      reason: "company-subject",
      vehicleRef: vehicleReference(haystack),
    };
  }
  if (input.autoSubmitted) return ignore("auto-submitted", true);
  if (input.listUnsubscribe || input.bulk) return ignore("newsletter", true);
  if (isBlockedEmailSender(from)) return ignore("blocked-sender", true);
  if (isSecurityNotice(subject, fresh)) return ignore("security-or-otp", true);
  if (!folded) return ignore("empty", false);
  if (SPAM_RE.test(folded) && !INQUIRY_RE.test(folded)) return ignore("spam", true);
  if (AD_RE.test(folded) && !INQUIRY_RE.test(folded)) return ignore("ad", true);
  if (RECEIPT_RE.test(folded) && !INQUIRY_RE.test(folded)) return ignore("receipt", true);
  if (hasStrongVehicleSignal(haystack)) {
    return { ingest: true, hardReject: false, reason: "vehicle", vehicleRef: vehicleReference(haystack) };
  }
  return ignore("not-car", false);
}
