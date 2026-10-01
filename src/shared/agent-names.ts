export const AGENT_FIRST_NAMES = [
  'Aed',
  'Aidan',
  'Ailbe',
  'Ailin',
  'Aine',
  'Alby',
  'Angus',
  'Aoife',
  'Ardal',
  'Art',
  'Bairr',
  'Barry',
  'Benen',
  'Blath',
  'Bran',
  'Brian',
  'Brion',
  'Bron',
  'Cian',
  'Ciara',
  'Ciar',
  'Clod',
  'Colm',
  'Con',
  'Conan',
  'Conor',
  'Daire',
  'Dara',
  'Deara',
  'Deird',
  'Donal',
  'Donn',
  'Doran',
  'Eamon',
  'Eanna',
  'Eith',
  'Emer',
  'Enya',
  'Eoin',
  'Eriu',
  'Etain',
  'Ferg',
  'Fiach',
  'Finn',
  'Fionn',
  'Gael',
  'Hugh',
  'Iarl',
  'Ide',
  'Iona',
  'Keela',
  'Kevin',
  'Kian',
  'Liad',
  'Liam',
  'Lir',
  'Lugh',
  'Mae',
  'Maire',
  'Maura',
  'Maeve',
  'Meadh',
  'Muir',
  'Nessa',
  'Niall',
  'Niamh',
  'Nola',
  'Nora',
  'Oisin',
  'Oran',
  'Orla',
  'Oscar',
  'Owen',
  'Padra',
  'Paddy',
  'Rian',
  'Ronan',
  'Rory',
  'Ruair',
  'Ruari',
  'Sean',
  'Shane',
  'Sile',
  'Sive',
  'Tadhg',
  'Tara',
  'Teige',
  'Una',
] as const

export const AGENT_SURNAMES = [
  'Ahern',
  'Barry',
  'Beggy',
  'Boyle',
  'Boyne',
  'Brady',
  'Breen',
  'Brett',
  'Brody',
  'Burke',
  'Burns',
  'Byrne',
  'Canny',
  'Carey',
  'Carr',
  'Casey',
  'Clark',
  'Clune',
  'Cody',
  'Coen',
  'Cogan',
  'Cole',
  'Comyn',
  'Corry',
  'Cox',
  'Crean',
  'Crowe',
  'Daly',
  'Darcy',
  'Davin',
  'Davy',
  'Deane',
  'Deasy',
  'Devoy',
  'Dolan',
  'Doran',
  'Dowd',
  'Doyle',
  'Duffy',
  'Dunne',
  'Egan',
  'Ennis',
  'Fahy',
  'Farry',
  'Fay',
  'Fee',
  'Finn',
  'Flood',
  'Flynn',
  'Foley',
  'Forde',
  'Fox',
  'Garry',
  'Gavan',
  'Gavin',
  'Glynn',
  'Gough',
  'Grant',
  'Hayes',
  'Healy',
  'Hearn',
  'Hogan',
  'Horan',
  'Hynes',
  'Joyce',
  'Kane',
  'Keane',
  'Kelly',
  'Kenny',
  'Kerr',
  'Kiely',
  'Kirby',
  'Kerin',
  'Lacey',
  'Lane',
  'Leahy',
  'Leary',
  'Lee',
  'Lowe',
  'Lynch',
  'Lyons',
  'Magee',
  'Magan',
  'Maher',
  'Mann',
  'Meade',
  'Moran',
  'Mulry',
  'Nagle',
  'Neary',
  'Neill',
  'Nolan',
  'Noone',
  'Oates',
  'Power',
  'Quinn',
  'Rea',
  'Reid',
  'Reidy',
  'Roach',
  'Roche',
  'Ryan',
  'Shea',
  'Sheil',
  'Shiel',
  'Slane',
  'Smith',
  'Smyth',
  'Stack',
  'Tobin',
  'Toole',
  'Tracy',
  'Tuohy',
  'Wade',
  'Walsh',
  'Ward',
  'Warde',
  'White',
  'Wolfe',
] as const

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

function agentNameAt(index: number): string {
  const firstName = AGENT_FIRST_NAMES[index % AGENT_FIRST_NAMES.length]
  const surname = AGENT_SURNAMES[Math.floor(index / AGENT_FIRST_NAMES.length)]
  return `${firstName} ${surname}`
}

const AGENT_NAME_COUNT = AGENT_FIRST_NAMES.length * AGENT_SURNAMES.length

// Generic layout-template tab labels ("Agent", "Agent 2", "A1"…) are slot
// placeholders, not identities. Workspace creation treats them as unnamed so
// every agent gets a real name;
// any other template name (a user-saved template's "Reviewer") is kept.
// When the record id is known, an exact match also identifies the fallback
// written by a terminal event before the agent's name reached the registry.
export function isPlaceholderAgentName(name: string | null | undefined, agentId?: string): boolean {
  const trimmed = name?.trim() ?? ''
  return !trimmed || trimmed === agentId || /^(agent(\s+\d+)?|a\d+)$/i.test(trimmed)
}

export function pickRandomAgentName(takenNames: Iterable<string> = []): string {
  const taken = new Set(Array.from(takenNames, normalizeName).filter(Boolean))
  const availableIndexes: number[] = []
  for (let index = 0; index < AGENT_NAME_COUNT; index += 1) {
    if (!taken.has(normalizeName(agentNameAt(index)))) availableIndexes.push(index)
  }

  const pool =
    availableIndexes.length > 0 ? availableIndexes : Array.from({ length: AGENT_NAME_COUNT }, (_, index) => index)
  const baseName = agentNameAt(pool[Math.floor(Math.random() * pool.length)])

  if (!taken.has(normalizeName(baseName))) return baseName

  let suffix = 2
  let candidate = `${baseName} ${suffix}`
  while (taken.has(normalizeName(candidate))) {
    suffix += 1
    candidate = `${baseName} ${suffix}`
  }

  return candidate
}
