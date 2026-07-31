/**
 * Deterministic privacy classification for screen content — rules, not a model, so every
 * verdict carries its evidence and can be explained or fixed (design-principles.md §2).
 *
 * Tiers and their pipeline effects (wired in main.ts / stm.ts):
 *   normal    — everything allowed
 *   personal  — kept in STM, but the distiller is told; no screen-derived LTM facts
 *   sensitive — she may glance (transient visual context) but nothing persists: no STM text,
 *               no ASR hint, no copilot frame, and no proactive/initiative off it
 *   secret    — like sensitive, and the text is dropped the moment it is recognized
 */

export type PrivacyClass = 'normal' | 'personal' | 'sensitive' | 'secret'

export interface PrivacyVerdict {
  privacy: PrivacyClass
  /** The rule that fired — verdicts must be explainable */
  evidence: string
  ruleVersion: string
}

const RULE_VERSION = 'v1'

const SECRET_TITLE = /1password|keepass|bitwarden|authenticator|api key/i
const SECRET_TEXT =
  /\bsk-[a-z0-9]{4,}|api[ _-]?key|secret key|private key|passphrase|\bpassword\b|密码|私钥|助记词|verification code|验证码|一次性密码/i

const SENSITIVE_TITLE = /avanza|nordnet|etrade|schwab|fidelity|binance|coinbase|骨科|诊疗|病历/i
// Account-shaped signals: balances, purchasing power, or a holdings TABLE (three of the four
// column markers co-occurring — full-screen captures have no window title to key on, so the
// text shape is the main line of defense). Mere ticker talk in articles must stay normal.
const SENSITIVE_TEXT =
  /(总价值|账户余额|可用于买入|购买力|account value|buying power|total value)[\s\S]{0,80}(kr|\$|€|¥|元)|\bGAV\b|(股数|市值|盈亏|权重|持仓)([\s\S]{0,80}(股数|市值|盈亏|权重|持仓)){2}|(诊断|处方|化验单|病历号)|(账号.{0,6}(尾号|末四位))/i

const PERSONAL_TITLE = /gmail|outlook|proton ?mail|邮箱|微信|wechat|telegram|whatsapp|messenger|日历|calendar/i

export function classifyScreen(sourceApp: string, text: string): PrivacyVerdict {
  const title = sourceApp || ''
  if (SECRET_TITLE.test(title)) {
    return { privacy: 'secret', evidence: `title:${title.slice(0, 40)}`, ruleVersion: RULE_VERSION }
  }
  const secretHit = SECRET_TEXT.exec(text)
  if (secretHit) {
    return { privacy: 'secret', evidence: `text:${secretHit[0].slice(0, 30)}`, ruleVersion: RULE_VERSION }
  }
  if (SENSITIVE_TITLE.test(title)) {
    return { privacy: 'sensitive', evidence: `title:${title.slice(0, 40)}`, ruleVersion: RULE_VERSION }
  }
  const sensitiveHit = SENSITIVE_TEXT.exec(text)
  if (sensitiveHit) {
    return {
      privacy: 'sensitive',
      evidence: `text:${sensitiveHit[0].slice(0, 30)}`,
      ruleVersion: RULE_VERSION
    }
  }
  if (PERSONAL_TITLE.test(title)) {
    return { privacy: 'personal', evidence: `title:${title.slice(0, 40)}`, ruleVersion: RULE_VERSION }
  }
  return { privacy: 'normal', evidence: 'no rule fired', ruleVersion: RULE_VERSION }
}
