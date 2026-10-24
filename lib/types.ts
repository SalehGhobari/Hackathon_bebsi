export type DeviceClass = "laptop" | "desktop" | "other";
export type Status = "good" | "fair" | "poor" | "unknown";
export type Confidence = "high" | "medium" | "low";
export type Severity = "low" | "medium" | "high" | "critical";

export type CpuInfo = {
  model: string;
  physicalCores: number;
  threads: number;
  arch: string;
  maxMhz: number | null;
};

export type RamInfo = {
  totalGb: number;
  type: string | null;
  formFactor: string | null;
  assumed: boolean;
};

export type SmartInfo = {
  available: boolean;
  health: "passed" | "failed" | "unknown";
  temperatureC: number | null;
  powerOnHours: number | null;
  enduranceUsedPct: number | null;
  mediaErrors: number | null;
  note?: string;
};

export type DiskInfo = {
  name: string;
  model: string;
  sizeGb: number;
  rotational: boolean;
  transport: string;
  smart: SmartInfo;
};

export type BatteryInfo = {
  present: boolean;
  designWh: number | null;
  fullWh: number | null;
  healthPct: number | null;
  cycles: number | null;
  status: string | null;
  technology: string | null;
  note?: string;
};

export type ThermalSensor = { name: string; valueC: number };

export type ThermalInfo = {
  sensors: ThermalSensor[];
  maxC: number | null;
  fanRpm: number | null;
  note?: string;
};

export type StorageInfo = {
  mount: string;
  totalGb: number;
  freeGb: number;
  usedPct: number;
};

export type OsInfo = {
  platform: string;
  release: string;
  arch: string;
  uptimeHours: number;
  hostname: string;
};

export type HealthItem = {
  key: string;
  label: string;
  score: number | null;
  status: Status;
  summary: string;
  evidence: string[];
  confidence: Confidence;
};

export type HealthReport = {
  overall: number | null;
  items: HealthItem[];
  notes: string[];
};

export type Fault = {
  key: string;
  component: string;
  severity: Severity;
  title: string;
  detail: string;
  evidence: string[];
};

export type RemedyAction =
  | "service"
  | "upgrade"
  | "replace-part"
  | "harvest"
  | "recycle"
  | "replace-device";

export type Safety = "diy" | "shop" | "licensed" | "never";

export type MaterialAmount = { name: string; grams: number };

export type Remedy = {
  id: string;
  action: RemedyAction;
  hierarchy: number;
  title: string;
  description: string;
  costLow: number;
  costHigh: number;
  laborLow: number;
  laborHigh: number;
  yearsGained: number;
  costPerYear: number;
  co2eAvoidedKg: number;
  kgDiverted: number;
  materials: MaterialAmount[];
  safety: Safety;
  confidence: Confidence;
  priceRefs: string[];
  warnings: string[];
  steps: string[];
};

export type Diagnostic = {
  id: string;
  deviceId: string;
  createdAt: string;
  cpu: CpuInfo;
  ram: RamInfo;
  disks: DiskInfo[];
  battery: BatteryInfo;
  thermal: ThermalInfo;
  storage: StorageInfo;
  os: OsInfo;
  health: HealthReport;
  faults: Fault[];
  demo?: boolean;
};

export type PriceEntry = {
  id: string;
  category: string;
  item: string;
  spec: string;
  low: number;
  high: number;
  currency: string;
  city: string;
  source: string;
  sourceDate: string;
  notes?: string;
};

export type Device = {
  id: string;
  name: string;
  class: DeviceClass;
  brand: string | null;
  model: string | null;
  serialHash: string | null;
  year: number | null;
  notes: string;
  createdAt: string;
  lastSeenAt: string;
  platform?: string | null;
  hints?: string[];
};

export type ActionRecord = {
  id: string;
  deviceId: string;
  diagnosticId: string;
  remedyId: string;
  action: RemedyAction;
  title: string;
  cost: number;
  co2eAvoidedKg: number;
  kgDiverted: number;
  materials: MaterialAmount[];
  createdAt: string;
};

export type Ledger = {
  devices: number;
  actions: number;
  co2eAvoidedKg: number;
  kgDiverted: number;
  jodSaved: number;
  materials: MaterialAmount[];
};

export type WipeRecord = {
  claimedAt: string;
  method: string;
  disk: string;
  serialHash: string | null;
  nonceHash: string;
  note: string;
};

export type Passport = {
  version: 1;
  id: string;
  issuedAt: string;
  device: { name: string; brand: string | null; model: string | null; class: DeviceClass };
  health: { overall: number | null; batteryPct: number | null; storage: string };
  impact: { co2eAvoidedKg: number; kgDiverted: number; materials: MaterialAmount[] };
  wipe: WipeRecord | null;
  hash: string;
};
