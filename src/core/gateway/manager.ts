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
import { getCredentialStore, type CredentialStore, type GatewayCredential } from './credential';

export interface GatewayManager {
    gateway: GatewayClient | null;
    isConnected(): boolean;
    credentialSaved(): boolean;
    credentialBackend(): 'keychain' | 'file' | null;
    forgetCredential(): void;
    markCredentialInvalid(): void;
    connect(passcode: string, gatewayUrl?: string): Promise<void>;
    disconnect(): Promise<void>;
    forget(): Promise<void>;
    ensureConnected(): Promise<void>;
}

interface CachedCredentials {
    gatewayUrl: string;
    passcode: string;
    savedAt: number;
}

const LEGACY_CRED_FILE = process.env.OH_MY_SAGE_CRED_FILE
    || path.join(os.homedir(), '.oh-my-sage', 'credentials.json');

/** @deprecated 兼容旧凭据文件：首次迁移到 CredentialStore 后删除 */
function migrateLegacyCredentials(store: CredentialStore): void {
    try {
        const parsed = JSON.parse(fs.readFileSync(LEGACY_CRED_FILE, 'utf8')) as CachedCredentials;
        if (parsed?.gatewayUrl && parsed?.passcode) {
            const current = store.load();
            if (!current) store.save({ gatewayUrl: parsed.gatewayUrl, passcode: parsed.passcode });
            try { fs.unlinkSync(LEGACY_CRED_FILE); } catch { /* ignore */ }
            console.error('[oh-my-sage] 旧凭据已迁移到', store.backend);
        }
    } catch {
        // 无旧文件
    }
}

export function createGatewayManager(): GatewayManager {
    const store = getCredentialStore();
    migrateLegacyCredentials(store);

    let gateway: GatewayClient | null = null;
    let connectChain: Promise<unknown> = Promise.resolve();
    let attemptCount = 0;
    let lastAttemptAt = 0;
    // 凭据熔断：连续认证失败达到阈值后停止自动重连，等用户重新 mijia_auth
    let credentialInvalid = false;
    const MAX_AUTH_FAILURES = 3;

    /** 串行化所有连接动作：同一时刻只允许一个握手在跑（防帧错乱） */
    function serialized<T>(task: () => Promise<T>): Promise<T> {
        const run = connectChain.then(task, task);
        connectChain = run.catch(() => { /* 链不断 */ });
        return run;
    }

    function isAuthFailure(e: unknown): boolean {
        const msg = e instanceof Error ? e.message : String(e);
        return /JPAKE|passcode|认证|protocol selection/i.test(msg);
    }

    async function autoConnect(reason: string): Promise<boolean> {
        return serialized(async () => {
            if (gateway !== null && gateway.isConnected()) return true;
            if (credentialInvalid) return false;
            const creds = store.load();
            if (!creds) return false;

            // 全局重连预算：指数退避（5s/15s/45s/...），封顶 5 分钟
            const sinceLast = Date.now() - lastAttemptAt;
            const backoff = Math.min(5000 * 3 ** attemptCount, 300000);
            if (lastAttemptAt > 0 && sinceLast < backoff) return false;
            lastAttemptAt = Date.now();

            let client: GatewayClient | null = null;
            try {
                console.error(`[oh-my-sage] auto-connect (${reason}, ${store.backend}): ${creds.gatewayUrl}`);
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
                // 认证型失败连续达阈值 → 熔断，防止拿失效码无限撞网关
                if (isAuthFailure(e) && attemptCount >= MAX_AUTH_FAILURES) {
                    credentialInvalid = true;
                    console.error(`[oh-my-sage] 凭据连续 ${attemptCount} 次认证失败，已停止自动重连；请重新 mijia_auth`);
                }
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
            // 断线自愈：有缓存凭据 → 后台触发一次重连（内部有指数退避预算）
            if (!credentialInvalid && store.load() !== null) {
                void autoConnect('reconnect');
            }
            return false;
        },

        credentialSaved(): boolean {
            return store.load() !== null;
        },

        credentialBackend(): 'keychain' | 'file' | null {
            return store.load() !== null ? store.backend : null;
        },

        forgetCredential(): void {
            store.clear();
            credentialInvalid = false;
            attemptCount = 0;
            lastAttemptAt = 0;
        },

        markCredentialInvalid(): void {
            credentialInvalid = true;
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
                // 断线监听：WS 一断（keepalive 判死 / 网关重启 / 网络闪断）立即调度自动重连
                client.onDisconnected(() => {
                    if (gateway === client) {
                        gateway = null;
                        setTimeout(() => { void autoConnect('ws-closed'); }, 1000);
                    }
                });
            });

            // 认证成功才持久化（P0 原则：失败绝不落盘）
            store.save({ gatewayUrl: url, passcode });
            credentialInvalid = false;
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
            attemptCount = 0;
            lastAttemptAt = 0;
            // disconnect ≠ logout：保留凭据，下次调用自动恢复连接
        },

        async forget(): Promise<void> {
            await serialized(async () => {
                if (gateway) {
                    try {
                        await gateway.close();
                    } catch {
                    }
                    gateway = null;
                }
            });
            attemptCount = 0;
            lastAttemptAt = 0;
            store.clear();
            credentialInvalid = false;
        },

        async ensureConnected(): Promise<void> {
            if (gateway !== null && gateway.isConnected()) return;

            const creds = store.load();
            if (!creds) {
                throw new Error('尚未保存网关凭据，请先调用 mijia_auth（认证成功后凭据自动保存，之后断线/重启均自动恢复）');
            }
            if (credentialInvalid) {
                throw new Error('保存的网关登录码已失效（连续认证失败），请重新调用 mijia_auth 输入新的登录码');
            }

            // 触发重连（若退避期内会返回 false），然后短暂轮询等待结果
            const ok = await autoConnect('ensure');
            if (!ok) {
                // 可能还在退避窗口；等待一个短周期再查
                for (let i = 0; i < 20 && (gateway === null || !gateway.isConnected()); i++) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
            if (gateway === null || !gateway.isConnected()) {
                throw new Error('网关连接建立中：正在用已保存的凭据自动重连，请几秒后重试');
            }
        },
    };
}
