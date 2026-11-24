// ISO 3166-1 alpha-2. Названия — через Intl.DisplayNames (без словаря в бандле).
const POPULAR = ['RU', 'UA', 'BY', 'KZ', 'UZ', 'KG', 'TJ', 'AM', 'AZ', 'GE', 'MD', 'TM', 'TR', 'DE', 'US', 'IL', 'AE', 'PL', 'LV', 'LT', 'EE'];
const ALL =
  'AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'.split(
    ' ',
  );

let names: Intl.DisplayNames | null = null;
try {
  names = new Intl.DisplayNames(['ru'], { type: 'region' });
} catch {
  names = null;
}

export function countryName(code: string): string {
  return names?.of(code) ?? code;
}

export function flag(code: string): string {
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export const COUNTRIES: string[] = [
  ...POPULAR,
  ...ALL.filter((c) => !POPULAR.includes(c)).sort((a, b) => countryName(a).localeCompare(countryName(b), 'ru')),
];
