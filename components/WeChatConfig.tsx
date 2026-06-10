"use client";

import { useCallback, useEffect, useState, useRef, type CSSProperties } from "react";
import { useEscapeClose } from "@/hooks/useEscapeClose";

interface WeChatStatus {
  connected: boolean;
  polling: boolean;
  accountId?: string;
  qrcodeUrl?: string;
  activeUserCount?: number;
  loginStatus?: string;
  loginError?: string;
}

export function WeChatConfig({ onClose }: { onClose: () => void }) {
  useEscapeClose(onClose);

  const [status, setStatus] = useState<WeChatStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/wechat", { cache: "no-store" });
      if (res.ok) setStatus(await res.json());
    } catch {
      // ignore
    }
  }, []);

  // 初始加载 + 定时轮询状态
  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchStatus]);

  const callApi = useCallback(async (action: string, body?: Record<string, unknown>) => {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/wechat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...body }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setMessage(data.message ?? "操作成功");
        // 刷新状态
        await fetchStatus();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [fetchStatus]);

  const isConnected = status?.connected ?? false;
  const isPolling = status?.polling ?? false;
  const showQrcode = !isConnected && status?.qrcodeUrl;

  // 构建二维码图片 URL
  const qrImageUrl = showQrcode
    ? `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(status!.qrcodeUrl!)}`
    : null;

  return (
    <div role="dialog" aria-modal="true" aria-label="微信 Bot" style={overlayStyle} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={modalStyle}>
        {/* 左侧面板 */}
        <aside style={asideStyle}>
          <div style={asideHeaderStyle}>
            <div>
              <div style={titleStyle}>微信 Bot</div>
              <div style={subStyle}>iLink Bot 接入</div>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
            {/* 连接状态 */}
            <div style={sectionStyle}>
              <div style={sectionTitleStyle}>连接状态</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                <span style={{
                  width: 10, height: 10, borderRadius: "50%",
                  background: isConnected ? (isPolling ? "#22c55e" : "#eab308") : "#6b7280",
                  boxShadow: isConnected ? `0 0 6px ${isPolling ? "#22c55e" : "#eab308"}` : "none",
                  flexShrink: 0,
                }} />
                <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 600 }}>
                  {isPolling ? "在线" : isConnected ? "已连接" : "未连接"}
                </span>
              </div>
              {status?.accountId && (
                <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-dim)", wordBreak: "break-all" }}>
                  ID: {status.accountId}
                </div>
              )}
              {status?.activeUserCount !== undefined && status.activeUserCount > 0 && (
                <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-dim)" }}>
                  活跃用户: {status.activeUserCount}
                </div>
              )}
            </div>

            {/* 操作按钮 */}
            <div style={sectionStyle}>
              <div style={sectionTitleStyle}>操作</div>

              {!isConnected && (
                <button
                  onClick={() => callApi("login")}
                  disabled={loading}
                  style={{ ...primaryBtnStyle, width: "100%", marginTop: 8 }}
                >
                  {loading ? "获取中..." : "扫码登录"}
                </button>
              )}

              {isConnected && !isPolling && (
                <button
                  onClick={() => callApi("start")}
                  disabled={loading}
                  style={{ ...primaryBtnStyle, width: "100%", marginTop: 8 }}
                >
                  {loading ? "启动中..." : "开始接收消息"}
                </button>
              )}

              {isPolling && (
                <button
                  onClick={() => callApi("stop")}
                  disabled={loading}
                  style={{ ...secondaryBtnStyle, width: "100%", marginTop: 8 }}
                >
                  停止接收
                </button>
              )}

              {isConnected && (
                <button
                  onClick={() => callApi("logout")}
                  disabled={loading}
                  style={{ ...dangerBtnStyle, width: "100%", marginTop: 6 }}
                >
                  退出登录
                </button>
              )}
            </div>
          </div>
        </aside>

        {/* 右侧主区域 */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={mainHeaderStyle}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text)" }}>
                {isConnected ? "微信 Bot 已就绪" : "扫码连接微信"}
              </div>
              <div style={subStyle}>
                {isPolling
                  ? "正在监听微信消息，Agent 将自动回复。"
                  : isConnected
                    ? "点击「开始接收消息」启动消息监听。"
                    : "点击「扫码登录」，用微信扫描二维码即可连接。"}
              </div>
            </div>
            <button onClick={onClose} style={closeBtnStyle}>×</button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            {/* 消息提示 */}
            {error && (
              <div style={errorBoxStyle}>
                <span style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>错误</span>
                <span style={{ fontSize: 12, opacity: 0.8 }}>{error}</span>
              </div>
            )}
            {message && (
              <div style={successBoxStyle}>
                <span style={{ fontSize: 12 }}>{message}</span>
              </div>
            )}

            {/* 二维码显示 */}
            {showQrcode && qrImageUrl ? (
              <div style={{ textAlign: "center" }}>
                <div style={{
                  border: "1px solid var(--border)",
                  borderRadius: 16,
                  padding: 16,
                  background: "#fff",
                  display: "inline-block",
                  marginBottom: 16,
                }}>
                  <img
                    src={qrImageUrl}
                    alt="微信扫码"
                    style={{ width: 220, height: 220, display: "block" }}
                  />
                </div>
                <div style={qrcodeHintStyle}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
                    请使用微信扫描二维码
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    扫码后点击确认，Bot 将自动连接
                  </div>
                </div>
              </div>
            ) : isConnected && !showQrcode ? (
              <div style={{ textAlign: "center" }}>
                <div style={checkIconStyle}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginTop: 12 }}>
                  {isPolling ? "✅ 已连接并在线" : "✅ 已连接"}
                </div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 6 }}>
                  {isPolling
                    ? "在微信中给你的 Bot 发送消息，Agent 将自动回复。"
                    : "点击左侧「开始接收消息」以启动消息监听。"}
                </div>
              </div>
            ) : (
              <div style={{ textAlign: "center", color: "var(--text-muted)" }}>
                <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.3 }}>💬</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>微信 Bot</div>
                <div style={{ fontSize: 12, marginTop: 4, opacity: 0.7 }}>
                  扫码连接后，即可在微信中与 DeerHux 对话
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

// ── Styles ──

const overlayStyle: CSSProperties = {
  position: "fixed", inset: 0, zIndex: 1000,
  display: "flex", alignItems: "center", justifyContent: "center",
  background: "rgba(0,0,0,0.35)", padding: 20,
};

const modalStyle: CSSProperties = {
  width: "min(720px, calc(100vw - 40px))",
  height: "min(560px, calc(100vh - 40px))",
  border: "1px solid var(--border)",
  borderRadius: 16,
  background: "var(--bg)",
  boxShadow: "0 18px 60px rgba(0,0,0,0.28)",
  overflow: "hidden",
  display: "flex",
};

const asideStyle: CSSProperties = {
  width: 240,
  borderRight: "1px solid var(--border)",
  background: "var(--bg-panel)",
  display: "flex",
  flexDirection: "column",
};

const asideHeaderStyle: CSSProperties = {
  padding: 16,
  borderBottom: "1px solid var(--border)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const titleStyle: CSSProperties = {
  fontSize: 16, fontWeight: 800, color: "var(--text)",
};

const subStyle: CSSProperties = {
  fontSize: 12, color: "var(--text-muted)", marginTop: 3,
};

const sectionStyle: CSSProperties = {
  marginBottom: 20,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "var(--text-dim)",
  textTransform: "uppercase", letterSpacing: "0.5px",
};

const mainHeaderStyle: CSSProperties = {
  padding: "14px 18px",
  borderBottom: "1px solid var(--border)",
  display: "flex", alignItems: "center", gap: 12,
};

const closeBtnStyle: CSSProperties = {
  width: 30, height: 30, borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--bg-panel)",
  color: "var(--text-muted)",
  cursor: "pointer", fontSize: 18,
};

const primaryBtnStyle: CSSProperties = {
  padding: "9px 14px", borderRadius: 9,
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  color: "white", cursor: "pointer",
  fontSize: 13, fontWeight: 700,
};

const secondaryBtnStyle: CSSProperties = {
  padding: "9px 14px", borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--bg-panel)",
  color: "var(--text)", cursor: "pointer",
  fontSize: 13,
};

const dangerBtnStyle: CSSProperties = {
  padding: "9px 14px", borderRadius: 9,
  border: "1px solid rgba(239,68,68,0.3)",
  background: "rgba(239,68,68,0.06)",
  color: "#ef4444", cursor: "pointer",
  fontSize: 12,
};

const errorBoxStyle: CSSProperties = {
  width: "100%", maxWidth: 380,
  padding: "12px 16px",
  borderRadius: 10,
  border: "1px solid rgba(239,68,68,0.25)",
  background: "rgba(239,68,68,0.06)",
  color: "#ef4444",
  marginBottom: 20,
  display: "flex", flexDirection: "column",
};

const successBoxStyle: CSSProperties = {
  width: "100%", maxWidth: 380,
  padding: "10px 16px",
  borderRadius: 10,
  border: "1px solid rgba(34,197,94,0.25)",
  background: "rgba(34,197,94,0.06)",
  color: "#22c55e",
  marginBottom: 20,
};

const qrcodeHintStyle: CSSProperties = {
  color: "var(--text-muted)",
};

const checkIconStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 80, height: 80,
  borderRadius: "50%",
  background: "rgba(34,197,94,0.1)",
  color: "#22c55e",
};
