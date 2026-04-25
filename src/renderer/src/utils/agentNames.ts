export const AGENT_NAMES = [
  'Avery',
  'Bailey',
  'Blair',
  'Brett',
  'Cameron',
  'Casey',
  'Charlie',
  'Dakota',
  'Drew',
  'Eden',
  'Elliot',
  'Emery',
  'Finley',
  'Frankie',
  'Gray',
  'Harper',
  'Hayden',
  'Jamie',
  'Jordan',
  'Kai',
  'Kendall',
  'Lane',
  'Logan',
  'Morgan',
  'Noel',
  'Parker',
  'Payton',
  'Quinn',
  'Reese',
  'Remy',
  'Riley',
  'Robin',
  'Rowan',
  'Sage',
  'Sawyer',
  'Skyler',
  'Spencer',
  'Taylor',
  'Terry',
  'Wren',
  'Alex',
  'Amari',
  'Arden',
  'Ash',
  'Aubrey',
  'August',
  'Bellamy',
  'Briar',
  'Brook',
  'Carey',
  'Carson',
  'Cassidy',
  'Corey',
  'Dallas',
  'Darcy',
  'Devon',
  'Ellis',
  'Emerson',
  'Everest',
  'Fallon',
  'Flynn',
  'Francis',
  'Gale',
  'Hadley',
  'Hollis',
  'Indigo',
  'Jules',
  'Justice',
  'Keegan',
  'Kennedy',
  'Kit',
  'Lake',
  'Lennox',
  'Linden',
  'Marlowe',
  'Merritt',
  'Monroe',
  'Murphy',
  'Nico',
  'Oakley',
  'Perry',
  'Phoenix',
  'Reagan',
  'River',
  'Rory',
  'Scout',
  'Shawn',
  'Sidney',
  'Sterling',
  'Sutton',
  'Tatum',
  'Teagan',
  'Tobin',
  'Tracy',
  'Val',
  'Winter',
  'Yael',
  'Zion',
  'Adrian',
  'Arlo',
] as const

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

export function pickRandomAgentName(takenNames: Iterable<string> = []): string {
  const taken = new Set(Array.from(takenNames, normalizeName).filter(Boolean))
  const available = AGENT_NAMES.filter((name) => !taken.has(normalizeName(name)))
  const pool = available.length > 0 ? available : AGENT_NAMES
  const baseName = pool[Math.floor(Math.random() * pool.length)]

  if (!taken.has(normalizeName(baseName))) return baseName

  let suffix = 2
  let candidate = `${baseName} ${suffix}`
  while (taken.has(normalizeName(candidate))) {
    suffix += 1
    candidate = `${baseName} ${suffix}`
  }

  return candidate
}
