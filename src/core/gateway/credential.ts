/**
 * Core - 网关凭据持久化（CredentialStore）
 *
 * 优先级：
 * 1. macOS Keychain（passcode 加密存系统钥匙串，推荐）
 * 2. 文件 fallback（~/.oh-my-sage/credentials.json，0600）——非 macOS 或 Keychain 不可用时
 *
 * gatewayUrl 非敏感，统一存 ~/.oh-my-sage/config.json
 * passcode 敏感：macOS 存 Keychain（service=oh-my-sage, account=mijia-gateway）
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

export interface GatewayCredential {
    gatewayUrl: string;
    passcode: string;
}

export interface CredentialStore {
    load(): GatewayCredential | null;
    save(credential: GatewayCredential): void;
    clear(): void;
    backend: 'keychain' | 'file';
}

const CONFIG_DIR = path.join(os.homedir(), '.oh-my-sage');
const URL_FILE = path.join(CONFIG_DIR, 'config.json');
const LEGACY_CRED_FILE = path.join(CONFIG_DIR, 'credentials.json');

const KEYCHAIN_SERVICE = 'oh-my-sage';
const KEYCHAIN_ACCOUNT = 'mijia-gateway';

function loadUrl(): string | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(URL_FILE, 'utf8'));
        if (parsed?.gatewayUrl) return parsed.gatewayUrl;
    } catch { /* not found */ }
    // 兼容旧 credentials.json 里的 URL
    try {
        const parsed = JSON.parse(fs.readFileSync(LEGACY_CRED_FILE, 'utf8'));
        if (parsed?.gatewayUrl) return parsed.gatewayUrl;
    } catch { /* not found */ }
    return null;
}

function saveUrl(gatewayUrl: string): void {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(URL_FILE, JSON.stringify({ gatewayUrl }, null, 2), { mode: 0o600 });
}

function clearUrl(): void {
    try { fs.unlinkSync(URL_FILE); } catch { /* gone */ }
}

/** macOS security CLI（无需额外依赖） */
function keychainExec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('security', args, { timeout: 5000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr?.toString().trim() || err.message));
            else resolve(stdout.toString());
        });
    });
}

async function keychainFind(): Promise<string | null> {
    try {
        const out = await keychainExec(['find-generic-password', '-w', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT]);
        const passcode = out.trim();
        return /^\d{6}$/.test(passcode) ? passcode : null;
    } catch {
        return null;
    }
}

async function keychainSave(passcode: string): Promise<void> {
    // -U 更新已存在条目
    await keychainExec(['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', passcode]);
}

async function keychainClear(): Promise<void> {
    try {
        await keychainExec(['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT]);
    } catch { /* already gone */ }
}

/** 文件 fallback（兼容旧行为） */
function fileLoad(): GatewayCredential | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(LEGACY_CRED_FILE, 'utf8'));
        if (parsed?.gatewayUrl && parsed?.passcode) return { gatewayUrl: parsed.gatewayUrl, passcode: parsed.passcode };
    } catch { /* gone */ }
    return null;
}

function fileSave(credential: GatewayCredential): void {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(LEGACY_CRED_FILE, JSON.stringify({ ...credential, savedAt: Date.now() }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(LEGACY_CRED_FILE, 0o600); } catch { /* best effort */ }
}

function fileClear(): void {
    try { fs.unlinkSync(LEGACY_CRED_FILE); } catch { /* gone */ }
}

const isMacOS = process.platform === 'darwin';

/**
 * 同步入口（manager 启动路径用）：
 * macOS 优先 Keychain——注意 security CLI 是异步的，这里提供同步探测 + 异步读取两层。
 */
export function getCredentialStore(): CredentialStore {
    if (isMacOS) {
        // 探测 Keychain 是否可用（登录会话有钥匙串；headless/无 UI 会失败 → fallback 文件）
        let keychainAvailable = false;
        try {
            require('child_process').execSync(
                `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" >/dev/null 2>&1 || echo NOTFOUND | grep -q NOTFOUND`,
                { stdio: 'ignore', timeout: 5000 }
            );
            keychainAvailable = true;
        } catch {
            keychainAvailable = false;
        }
        if (keychainAvailable) {
            return {
                backend: 'keychain',
                load(): GatewayCredential | null {
                    const url = loadUrl();
                    if (!url) return null;
                    // 同步桥：spawnSync 读取 Keychain
                    try {
                        const { execFileSync } = require('child_process') as typeof import('child_process');
                        const out = execFileSync('security',
                            ['find-generic-password', '-w', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
                            { timeout: 5000, encoding: 'utf8' }
                        ).trim();
                        if (!/^\d{6}$/.test(out)) return null;
                        return { gatewayUrl: url, passcode: out };
                    } catch {
                        return null;
                    }
                },
                save(credential: GatewayCredential): void {
                    saveUrl(credential.gatewayUrl);
                    try {
                        const { execFileSync } = require('child_process') as typeof import('child_process');
                        execFileSync('security',
                            ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', credential.passcode],
                            { timeout: 5000, stdio: 'ignore' }
                        );
                    } catch (e) {
                        console.error('[oh-my-sage] Keychain 写入失败，回退文件存储:', e instanceof Error ? e.message : e);
                        fileSave(credential);
                    }
                },
                clear(): void {
                    clearUrl();
                    try {
                        const { execFileSync } = require('child_process') as typeof import('child_process');
                        execFileSync('security',
                            ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
                            { timeout: 5000, stdio: 'ignore' }
                        );
                    } catch { /* gone */ }
                    // 彻底注销：旧版明文凭据文件也要清掉
                    fileClear();
                },
            };
        }
    }
    // 文件 fallback
    return {
        backend: 'file',
        load: fileLoad,
        save: fileSave,
        clear: fileClear,
    };
}
