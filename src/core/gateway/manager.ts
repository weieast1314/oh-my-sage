/**
 * Core - Gateway 连接管理器
 * 统一管理 Gateway 状态 + 本地凭据缓存（跨会话自动重连）
 *
 * 凭据缓存说明：
 * - mijia_auth 成功后把 {gatewayUrl, passcode} 存到 ~/.oh-my-sage/credentials.json (0600)
 * - 之后每次进程启动（MCP 新会话 / Web server 重启）自动用缓存凭据静默重连，
 *   无需再次输入登录码
 * - 网关协议是 EC-JPAKE（每次连接现场协商），不存在服务端 token；
 *   缓存的明文登录码等价于网关密码，仅存本机用户目录
 * - 显式调用 disconnect()（mijia_disconnect）会删除缓存文件
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GatewayClient } from './client';

export interface GatewayManager {
    gateway: GatewayClient | null;
    isConnected(): boolean;
    connect(passcode: string, gatewayUrl?: string): Promise<void>;
    disconnect(): Promise<void>;
    ensureConnected(): void;
}

interface CachedCredentials {
    gatewayUrl: string;
    passcode: string;
    savedAt: number;
}

const CRED_FILE = process.env.OH_MY_SAGE_CRED_FILE
    || path.join(os.homedir(), '.oh-my-sage', 'credentials.json');

function loadCachedCredentials(): CachedCredentials | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')) as CachedCredentials;
        if (parsed?.gatewayUrl && parsed?.passcode) return parsed;
    } catch {
        // 未认证过或文件损坏：当作无缓存
    }
    return null;
}

function saveCachedCredentials(creds: CachedCredentials): void {
    try {
        fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
        fs.writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
        try { fs.chmodSync(CRED_FILE, 0o600); } catch { /* best effort */ }
    } catch (e) {
        console.error('[oh-my-sage] 保存网关凭据失败:', e);
    }
}

function clearCachedCredentials(): void {
    try { fs.unlinkSync(CRED_FILE); } catch { /* already gone */ }
}

export function createGatewayManager(): GatewayManager {
    let gateway: GatewayClient | null = null;
    let connectChain: Promise<unknown> = Promise.resolve();
    let autoConnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attemptCount = 0;
    let lastAttemptAt = 0;

    /** 串行化所有连接动作：同一时刻只允许一个握手在跑（防帧错乱） */
    function serialized<T>(task: () => Promise<T>): Promise<T> {
        const run = connectChain.then(task, task);
        connectChain = run.catch(() => { /* 链不断 */ });
        return run;
    }

    async function autoConnect(reason: string): Promise<boolean> {
        return serialized(async () => {
            if (gateway !== null && gateway.isConnected()) return true;
            const creds = loadCachedCredentials();
            if (!creds) return false;

            // 全局重连预算：指数退避（5s/15s/45s/...），封顶 5 分钟
            const sinceLast = Date.now() - lastAttemptAt;
            const backoff = Math.min(5000 * 3 ** attemptCount, 300000);
            if (lastAttemptAt > 0 && sinceLast < backoff) return false;
            lastAttemptAt = Date.now();

            let client: GatewayClient | null = null;
            try {
                console.error(`[oh-my-sage] auto-connect (${reason}): ${creds.gatewayUrl}`);
                if (gateway) {
                    try { await gateway.close(); } catch { /* ignore */ }
                    gateway = null;
                }
                client = new GatewayClient();
                await client.connect(creds.gatewayUrl);
                await client.authenticate(creds.passcode);
                gateway = client;
                attemptCount = 0;
                console.error('[oh-my-sage] auto-connect succeeded');
                return true;
            } catch (e) {
                attemptCount += 1;
                console.error(
                    `[oh-my-sage] auto-connect failed (attempt ${attemptCount}, next in ~${Math.min(5000 * 3 ** attemptCount, 300000) / 1000}s):`,
                    e instanceof Error ? e.message : e
                );
                // 关键：失败也必须关掉 WS——否则每次失败泄漏一条网关连接，
                // 堆积的半开会话会占满网关会话槽、导致后续认证被拒
                if (client) { try { await client.close(); } catch { /* ignore */ } }
                gateway = null;
                return false;
            }
        });
    }

    // 进程启动即尝试用缓存凭据连接（fire-and-forget，MCP 新会话 / Web 启动均生效）
    void autoConnect('startup');

    return {
        get gateway() {
            return gateway;
        },

        isConnected(): boolean {
            if (gateway !== null && gateway.isConnected()) return true;
            // 断线自愈：有缓存凭据 → 后台触发一次重连（内部有指数退避预算，
            // 不会高频打网关；当前调用仍返回 false，工具层提示稍后重试）
            if (loadCachedCredentials() !== null) {
                void autoConnect('reconnect');
            }
            return false;
        },

        async connect(passcode: string, gatewayUrl?: string): Promise<void> {
            const url = gatewayUrl || process.env.GATEWAY_URL;
            if (!url) {
                throw new Error('未配置网关地址：请在 mijia_auth 的 gateway_url 参数中提供网关地址，或在 MCP 配置里设置 GATEWAY_URL 环境变量');
            }

            await serialized(async () => {
                if (gateway) {
                    try {
                        await gateway.close();
                    } catch {
                    }
                    gateway = null;
                }

                const client = new GatewayClient();
                await client.connect(url);
                await client.authenticate(passcode);
                gateway = client;
                // 断线监听：WS 一断（keepalive 判死 / 网关重启 / 网络闪断）立即调度自动重连，
                // 不再等下一次工具调用才发现。延迟 1s 给 serialized 链留出串行窗口。
                client.onDisconnected(() => {
                    if (gateway === client) {
                        gateway = null;
                        setTimeout(() => { void autoConnect('ws-closed'); }, 1000);
                    }
                });
            });

            saveCachedCredentials({ gatewayUrl: url, passcode, savedAt: Date.now() });
            attemptCount = 0;
            lastAttemptAt = 0;
        },

        async disconnect(): Promise<void> {
            await serialized(async () => {
                if (gateway) {
                    try {
                        await gateway.close();
                    } catch {
                    }
                    gateway = null;
                }
            });
            if (autoConnectTimer !== null) {
                clearTimeout(autoConnectTimer);
                autoConnectTimer = null;
            }
            attemptCount = 0;
            lastAttemptAt = 0;
            // 显式断开 = 撤销本机保存的登录码，之后需重新 mijia_auth
            clearCachedCredentials();
        },

        ensureConnected(): void {
            if (!this.isConnected()) {
                const hasCreds = loadCachedCredentials() !== null;
                throw new Error(hasCreds
                    ? '网关连接建立中：正在用已保存的凭据自动重连，请几秒后重试'
                    : '网关未连接，请先调用 mijia_auth（认证成功后会缓存凭据，之后新会话自动连接）');
            }
        },
    };
}
