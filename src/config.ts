import path from 'node:path';

export interface AppConfig {
  dataDir: string;
  warehouseDbPath: string;
  appDbPath: string;
  mockDbDir: string;
  host: string;
  port: number;
  mockPorts: { sms: number; wecom: number; ads: number };
  startMocks: boolean;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数, 当前值: ${raw}`);
  }
  return value;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = overrides.dataDir ?? process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
  return {
    dataDir,
    warehouseDbPath: overrides.warehouseDbPath ?? path.join(dataDir, 'warehouse.db'),
    appDbPath: overrides.appDbPath ?? path.join(dataDir, 'app.db'),
    mockDbDir: overrides.mockDbDir ?? path.join(dataDir, 'mocks'),
    host: overrides.host ?? process.env.HOST ?? '127.0.0.1',
    port: overrides.port ?? intEnv('PORT', 4100),
    mockPorts: overrides.mockPorts ?? {
      sms: intEnv('SMS_MOCK_PORT', 4101),
      wecom: intEnv('WECOM_MOCK_PORT', 4102),
      ads: intEnv('ADS_MOCK_PORT', 4103),
    },
    startMocks: overrides.startMocks ?? process.env.START_MOCKS !== '0',
  };
}
