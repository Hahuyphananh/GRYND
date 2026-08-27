"use client";

import { useState, useEffect, useCallback } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import AdminBadge from "../../components/AdminBadge";
import {
  IconChartBar,
  IconUsers,
  IconClipboardList,
  IconFlag,
  IconSearch,
  IconCoins,
  IconX,
  IconRefresh,
  IconMail,
  IconStar,
} from "@tabler/icons-react";
import { useSocket } from "../../context/SocketProvider";

// ── Types ─────────────────────────────────────────────────────────

interface DomainStats {
  prefix: string;
  hits: number;
  misses: number;
  forceFresh: number;
  sets: number;
  deletes: number;
}

interface CacheStatsResponse {
  success: boolean;
  summary: {
    hits: number;
    misses: number;
    forceFresh: number;
    sets: number;
    deletes: number;
    totalRequests: number;
    hitRate: string;
  };
  domains: Record<string, DomainStats>;
  mode: {
    verboseLogging: string;
    logFilter: string;
  };
}

type FlushScope = "all" | "leaderboards" | "user-stats" | "recent-games" | "big-wins";

interface AdminUser {
  id: number;
  clerkId: string;
  name: string;
  email: string;
  isAdmin: boolean;
}

interface AuditLogEntry {
  id: number;
  event: string;
  clerkId: string;
  targetClerkId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

interface PlayerReport {
  id: number;
  reporter_clerk_id: string;
  reported_clerk_id: string;
  game_type: string;
  game_id: string | null;
  reason: string;
  details: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by_clerk_id: string | null;
  reporter_name: string | null;
  reporter_email: string | null;
  reported_name: string | null;
  reported_email: string | null;
  reported_is_banned: boolean | null;
}

interface ContactMessageReply {
  id: number;
  message_id: number;
  admin_clerk_id: string;
  admin_name: string;
  reply: string;
  created_at: string;
}

interface ContactMessage {
  id: number;
  name: string | null;
  email: string;
  message: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  replies?: ContactMessageReply[];
}

// ── Component ─────────────────────────────────────────────────────

interface AdminDashboardClientProps {
  initialAdminVerified?: boolean;
}

export default function AdminDashboardClient({
  initialAdminVerified = false,
}: AdminDashboardClientProps) {
  const { isLoaded, isSignedIn, user } = useUser();
  const router = useRouter();
  const [stats, setStats] = useState<CacheStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [flushScope, setFlushScope] = useState<FlushScope>("all");

  // ── Maintenance-mode state ─────────────────────────────────────
  const [maintenanceMode, setMaintenanceMode] = useState<boolean | null>(null);
  const [maintenanceLoading, setMaintenanceLoading] = useState(false);

  // ── User management state ──────────────────────────────────────
  const [userSearch, setUserSearch] = useState("");
  const [searchedUsers, setSearchedUsers] = useState<AdminUser[]>([]);
  const [userSearchLoading, setUserSearchLoading] = useState(false);
  const [userToggleLoading, setUserToggleLoading] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<
    "cache" | "users" | "audit" | "reports" | "messages" | "reviews"
  >("cache");
  const [adminVerified, setAdminVerified] = useState(initialAdminVerified);

  // ── Audit log state ────────────────────────────────────────────
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditLogLoading, setAuditLogLoading] = useState(false);

  // ── Reports state ──────────────────────────────────────────────
  const [reports, setReports] = useState<PlayerReport[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [banLoading, setBanLoading] = useState<string | null>(null);

  // ── Contact messages state ─────────────────────────────────────
  const [messages, setMessages] = useState<ContactMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messageActionLoading, setMessageActionLoading] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<ContactMessage | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replySending, setReplySending] = useState(false);

  // ── Realtime notification badges ───────────────────────────────
  // Counts of new player reports / contact messages that arrived while the
  // tab was closed. Cleared when the tab is opened.
  const [reportNotifCount, setReportNotifCount] = useState(0);
  const [messageNotifCount, setMessageNotifCount] = useState(0);

  // ── Reviews state ──────────────────────────────────────────────
  interface AdminReview {
    id: number;
    userId: number;
    rating: number;
    title: string | null;
    body: string | null;
    game: string | null;
    status: string;
    createdAt: string;
    username: string;
    email: string;
  }
  const [reviews, setReviews] = useState<AdminReview[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [reviewFilter, setReviewFilter] = useState("pending");
  const [reviewActionLoading, setReviewActionLoading] = useState<number | null>(null);

  // ── Token reset state ──────────────────────────────────────────
  const [tokenResetTarget, setTokenResetTarget] = useState<AdminUser | null>(null);
  const [tokenResetAmount, setTokenResetAmount] = useState("");
  const [tokenResetLoading, setTokenResetLoading] = useState(false);

  // Redirect non-authenticated users
  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      router.push("/sign-in");
    }
  }, [isLoaded, isSignedIn, router]);

  // Hard gate: verify DB-backed admin status and redirect non-admins away
  useEffect(() => {
    if (initialAdminVerified || !isSignedIn || !user?.id) return;
    fetch("/api/user/is-admin")
      .then((res) => res.json())
      .then((data) => {
        if (data.isAdmin === true) {
          setAdminVerified(true);
        } else {
          router.replace("/");
        }
      })
      .catch(() => router.replace("/"));
  }, [initialAdminVerified, isSignedIn, user?.id, router]);

  // Second-layer defense: if a cache-stats API call returns 403 mid-session
  // (e.g. admin was revoked), immediately redirect away
  useEffect(() => {
    if (accessDenied) {
      router.replace("/");
    }
  }, [accessDenied, router]);

  // Fetch stats
  const fetchStats = useCallback(async () => {
    setLoading(true);
    setAccessDenied(false);
    setError(null);
    try {
      const res = await fetch("/api/admin/cache-stats");
      const data = await res.json();
      if (data.success) {
        setStats(data);
        setAccessDenied(false);
      } else if (res.status === 403) {
        setAccessDenied(true);
      } else {
        setError(data.error || "Failed to fetch stats");
      }
    } catch {
      setError("Network error fetching stats");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isSignedIn && adminVerified) fetchStats();
  }, [isSignedIn, adminVerified, fetchStats]);

  // Load current maintenance state
  useEffect(() => {
    if (!isSignedIn || !adminVerified) return;
    fetch("/api/admin/maintenance")
      .then((res) => res.json())
      .then((data) => {
        if (data.success) setMaintenanceMode(Boolean(data.maintenanceMode));
      })
      .catch(() => {});
  }, [isSignedIn, adminVerified]);

  // Toggle maintenance mode (runtime kill switch)
  const handleToggleMaintenance = async () => {
    setMaintenanceLoading(true);
    setActionResult(null);
    try {
      const res = await fetch("/api/admin/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !maintenanceMode }),
      });
      const data = await res.json();
      if (data.success) {
        setMaintenanceMode(Boolean(data.maintenanceMode));
        setActionResult(data.message);
      } else {
        setActionResult("Error: " + data.error);
      }
    } catch {
      setActionResult("Network error toggling maintenance");
    } finally {
      setMaintenanceLoading(false);
    }
  };

  // Flush cache
  const handleFlush = async () => {
    setActionLoading("flush");
    setActionResult(null);
    try {
      const res = await fetch("/api/admin/flush-cache", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: flushScope }),
      });
      const data = await res.json();
      if (data.success) {
        setActionResult("Flushed: " + data.flushed.join(", "));
        fetchStats();
      } else {
        setActionResult("Error: " + data.error);
      }
    } catch {
      setActionResult("Network error");
    } finally {
      setActionLoading(null);
    }
  };

  // ── User search handler ────────────────────────────────────────
  async function handleUserSearch() {
    if (!userSearch.trim()) return;
    setUserSearchLoading(true);
    setActionResult(null);
    setTokenResetTarget(null);
    setTokenResetAmount("");
    try {
      const res = await fetch(
        "/api/admin/users?search=" + encodeURIComponent(userSearch.trim()),
      );
      const data = await res.json();
      if (data.success) {
        setSearchedUsers(data.users);
      } else {
        setActionResult("Error: " + data.error);
      }
    } catch {
      setActionResult("Network error searching users");
    } finally {
      setUserSearchLoading(false);
    }
  }

  // ── Token reset handler ───────────────────────────────────────
  async function handleResetTokens() {
    if (!tokenResetTarget || !tokenResetAmount.trim()) return;
    const amount = Number(tokenResetAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      setActionResult("Please enter a valid non-negative number.");
      return;
    }
    setTokenResetLoading(true);
    setActionResult(null);
    try {
      const res = await fetch("/api/admin/reset-tokens", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clerkId: tokenResetTarget.clerkId, balance: amount }),
      });
      const data = await res.json();
      if (data.success) {
        setActionResult(
          `${data.data.name}'s balance set to ${data.data.newBalance} tokens.`,
        );
        setTokenResetTarget(null);
        setTokenResetAmount("");
      } else {
        setActionResult("Error: " + data.error);
      }
    } catch {
      setActionResult("Network error resetting tokens");
    } finally {
      setTokenResetLoading(false);
    }
  }

  // ── Toggle admin handler ───────────────────────────────────────
  async function handleToggleAdmin(u: AdminUser) {
    setUserToggleLoading(u.clerkId);
    setActionResult(null);
    try {
      const res = await fetch("/api/admin/users/" + u.clerkId + "/admin", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isAdmin: !u.isAdmin }),
      });
      const data = await res.json();
      if (data.success) {
        setActionResult(
          data.name + " is now " + (data.isAdmin ? "an admin" : "not an admin"),
        );
        // Update local state
        setSearchedUsers((prev) =>
          prev.map((user) =>
            user.clerkId === u.clerkId
              ? { ...user, isAdmin: data.isAdmin }
              : user,
          ),
        );
      } else {
        setActionResult("Error: " + data.error);
      }
    } catch {
      setActionResult("Network error toggling admin");
    } finally {
      setUserToggleLoading(null);
    }
  }

  // Reset stats (with optional flush)
  const handleReset = async (alsoFlush: boolean) => {
    setActionLoading("reset");
    setActionResult(null);
    try {
      const url = alsoFlush
        ? "/api/admin/cache-stats?flush=1"
        : "/api/admin/cache-stats";
      const res = await fetch(url, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        setActionResult(data.message);
        fetchStats();
      } else {
        setActionResult("Error: " + data.error);
      }
    } catch {
      setActionResult("Network error");
    } finally {
      setActionLoading(null);
    }
  };

  // ── Fetch audit logs ───────────────────────────────────────────
  const fetchAuditLogs = useCallback(async (limit = 50) => {
    setAuditLogLoading(true);
    try {
      const res = await fetch("/api/admin/audit-logs?limit=" + limit);
      const data = await res.json();
      if (data.success) {
        setAuditLogs(data.logs);
      }
    } catch {
      setActionResult("Network error fetching audit logs");
    } finally {
      setAuditLogLoading(false);
    }
  }, []);

  // ── Load admin team ────────────────────────────────────────────
  async function loadAdminTeam() {
    setUserSearchLoading(true);
    setActionResult(null);
    try {
      const res = await fetch("/api/admin/users?admins=1&limit=50");
      const data = await res.json();
      if (data.success) {
        setSearchedUsers(data.users);
        if (data.users.length === 0) {
          setActionResult("No admin users found in the database.");
        }
      } else {
        setActionResult("Error: " + data.error);
      }
    } catch {
      setActionResult("Network error loading admin team");
    } finally {
      setUserSearchLoading(false);
    }
  }

  // Fetch audit logs when switching to audit tab
  useEffect(() => {
    if (activeTab === "audit" && auditLogs.length === 0) {
      fetchAuditLogs();
    }
  }, [activeTab, auditLogs.length, fetchAuditLogs]);

  // ── Fetch reports ──────────────────────────────────────────────
  const fetchReports = useCallback(async () => {
    setReportsLoading(true);
    try {
      const res = await fetch("/api/admin/reports?status=pending&limit=100");
      const data = await res.json();
      if (data.success) {
        setReports(data.reports || []);
      }
    } catch {
      setActionResult("Network error fetching reports");
    } finally {
      setReportsLoading(false);
    }
  }, []);

  // Fetch reports when switching to reports tab (and clear the live badge)
  useEffect(() => {
    if (activeTab === "reports") {
      setReportNotifCount(0);
      if (reports.length === 0) fetchReports();
    }
  }, [activeTab, reports.length, fetchReports]);

  // ── Fetch contact messages ─────────────────────────────────────
  const fetchMessages = useCallback(async () => {
    setMessagesLoading(true);
    try {
      const res = await fetch("/api/admin/contact-messages?limit=100");
      const data = await res.json();
      if (data.success) {
        setMessages(data.messages || []);
      }
    } catch {
      setActionResult("Network error fetching messages");
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  // Fetch messages when switching to messages tab (and clear the live badge)
  useEffect(() => {
    if (activeTab === "messages") {
      setMessageNotifCount(0);
      if (messages.length === 0) fetchMessages();
    }
  }, [activeTab, messages.length, fetchMessages]);

  // ── Live admin notifications via the Socket.IO admin room ──────
  // The backend pushes `admin:notify` events to the verified admin-only
  // room after inserting a player report / contact message (see
  // src/lib/adminNotify.ts + realtime-server/server.js). The badge counts
  // arrivals while the tab is closed; opening the tab resets it and fetches
  // the fresh queue (above). Re-joins on every socket (re)connection —
  // Socket.IO doesn't restore room membership automatically.
  const { socket } = useSocket();
  useEffect(() => {
    if (!isSignedIn || !adminVerified || !socket) return;
    const ADMIN_NOTIFICATIONS_ROOM = "admin:notifications";
    const join = () => socket.emit("admin:join");
    const onAdminNotify = (payload: { type?: string }) => {
      if (payload?.type === "report") {
        setReportNotifCount((c) => c + 1);
        if (activeTab === "reports") fetchReports();
      } else if (payload?.type === "message") {
        setMessageNotifCount((c) => c + 1);
        if (activeTab === "messages") fetchMessages();
      }
    };
    join();
    socket.on("connect", join);
    socket.on("admin:notify", onAdminNotify);
    return () => {
      socket.off("connect", join);
      socket.off("admin:notify", onAdminNotify);
      socket.emit("leave_room", { roomId: ADMIN_NOTIFICATIONS_ROOM });
    };
  }, [socket, isSignedIn, adminVerified, activeTab, fetchReports, fetchMessages]);

  // ── Fetch reviews (moderation queue) ───────────────────────────
  const fetchReviews = useCallback(async () => {
    setReviewsLoading(true);
    try {
      const res = await fetch("/api/admin/reviews?status=" + reviewFilter);
      const data = await res.json();
      if (data.success) {
        setReviews(data.reviews || []);
      }
    } catch {
      setActionResult("Network error fetching reviews");
    } finally {
      setReviewsLoading(false);
    }
  }, [reviewFilter]);

  useEffect(() => {
    if (activeTab === "reviews") fetchReviews();
  }, [activeTab, fetchReviews]);

  // ── Moderate review handler ────────────────────────────────────
  async function handleModerateReview(reviewId: number, action: string) {
    setReviewActionLoading(reviewId);
    setActionResult(null);
    try {
      const res = await fetch("/api/admin/reviews", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "delete" ? { id: reviewId, action } : { id: reviewId, status: action },
        ),
      });
      const data = await res.json();
      if (data.success) {
        setActionResult(
          action === "delete"
            ? "Review " + reviewId + " deleted."
            : "Review " + reviewId + " " + action + ".",
        );
        setReviews((prev) => prev.filter((r) => r.id !== reviewId));
      } else {
        setActionResult("Error: " + data.error);
      }
    } catch {
      setActionResult("Network error moderating review");
    } finally {
      setReviewActionLoading(null);
    }
  }

  // ── Mark message resolved / new handler ────────────────────────
  async function handleSetMessageStatus(messageId: number, status: string) {
    setMessageActionLoading(String(messageId));
    setActionResult(null);
    try {
      const res = await fetch("/api/admin/contact-messages", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, status }),
      });
      const data = await res.json();
      if (data.success) {
        setActionResult(
          status === "resolved"
            ? "Message " + messageId + " marked as resolved."
            : "Message " + messageId + " marked as new.",
        );
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, status } : m)),
        );
      } else {
        setActionResult("Error: " + data.error);
      }
    } catch {
      setActionResult("Network error updating message");
    } finally {
      setMessageActionLoading(null);
    }
  }

  // ── Send reply handler ──────────────────────────────────────────
  async function handleSendReply() {
    if (!replyTarget || !replyText.trim()) return;
    setReplySending(true);
    setActionResult(null);
    try {
      const res = await fetch("/api/admin/contact-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId: replyTarget.id,
          reply: replyText.trim(),
        }),
      });
      const data = await res.json();
      if (data.success) {
        setActionResult(
          "Reply sent to " + (replyTarget.name || replyTarget.email) + ".",
        );
        setReplyTarget(null);
        setReplyText("");
        fetchMessages();
      } else {
        setActionResult("Error: " + data.error);
      }
    } catch {
      setActionResult("Network error sending reply");
    } finally {
      setReplySending(false);
    }
  }

  // ── Delete message handler ──────────────────────────────────────
  async function handleDeleteMessage(m: ContactMessage) {
    if (
      !window.confirm(
        "Delete message #" +
          m.id +
          " from " +
          (m.name || m.email) +
          "? This also deletes its replies.",
      )
    ) {
      return;
    }
    setMessageActionLoading("delete-" + m.id);
    setActionResult(null);
    try {
      const res = await fetch("/api/admin/contact-messages", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: m.id }),
      });
      const data = await res.json();
      if (data.success) {
        setActionResult("Message #" + m.id + " deleted.");
        setMessages((prev) => prev.filter((x) => x.id !== m.id));
      } else {
        setActionResult("Error: " + data.error);
      }
    } catch {
      setActionResult("Network error deleting message");
    } finally {
      setMessageActionLoading(null);
    }
  }

  // ── Resolve report handler ──────────────────────────────────────
  async function handleResolveReport(reportId: number, status: string) {
    setBanLoading(String(reportId));
    setActionResult(null);
    try {
      const res = await fetch("/api/admin/reports", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId, status }),
      });
      const data = await res.json();
      if (data.success) {
        setActionResult("Report " + reportId + " marked as " + status + ".");
        setReports((prev) => prev.filter((r) => r.id !== reportId));
      } else {
        setActionResult("Error: " + data.error);
      }
    } catch {
      setActionResult("Network error updating report");
    } finally {
      setBanLoading(null);
    }
  }

  // ── Ban/unban handler ───────────────────────────────────────────
  async function handleToggleBan(clerkId: string, ban: boolean) {
    setBanLoading(clerkId);
    setActionResult(null);
    try {
      const res = await fetch("/api/admin/ban-user", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clerkId, ban }),
      });
      const data = await res.json();
      if (data.success) {
        setActionResult(data.name + " has been " + (ban ? "banned" : "unbanned") + ".");
      } else {
        setActionResult("Error: " + data.error);
      }
    } catch {
      setActionResult("Network error updating user");
    } finally {
      setBanLoading(null);
    }
  }

  // ── Format report reason for display ────────────────────────────
  function formatReason(reason: string): string {
    const labels: Record<string, string> = {
      toxic_player: "Toxic Player",
      hacker: "Hacker / Cheater",
      inappropriate_name: "Inappropriate Name",
      inappropriate_picture: "Inappropriate Picture",
      other: "Other",
    };
    return labels[reason] || reason.replace(/_/g, " ");
  }

  // ── Format event name for display ──────────────────────────────
  function formatEventName(event: string): string {
    const labels: Record<string, string> = {
      admin_toggle: "Toggle Admin",
      admin_cache_flush: "Cache Flush",
      admin_cache_stats_reset: "Stats Reset",
      admin_access_denied: "Access Denied",
    };
    return labels[event] || event.replace(/_/g, " ");
  }

  // ── Format timestamp for display ───────────────────────────────
  function formatTimestamp(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString();
  }

  // Show spinner while verifying admin status
  if (!isLoaded || !isSignedIn || !adminVerified) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-400 border-t-transparent" />
      </div>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-10">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.push("/")}
            className="px-4 py-2 rounded-lg border border-white/20 bg-white/5 text-sm text-gray-300 hover:bg-white/10 transition-colors"
          >
            ← Home
          </button>
          <div>
            <h1 className="text-3xl font-bold text-white tracking-tight">
              Admin Dashboard
            </h1>
            <p className="text-sm text-gray-400 mt-1">
              Signed in as{" "}
              <span className="text-gray-200">
                {user?.primaryEmailAddress?.emailAddress || user?.id}
              </span>
            </p>
          </div>
        </div>
        <button
          onClick={fetchStats}
          disabled={loading}
          className="px-4 py-2 bg-white/10 hover:bg-white/20 text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-50"
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Action result toast */}
      {actionResult && (
        <div className="mb-6 p-4 bg-green-500/10 border border-green-500/30 rounded-xl text-green-300 text-sm animate-in fade-in">
          {actionResult}
        </div>
      )}

      {/* Summary cards */}
      {stats && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
            {[
              { label: "Hit Rate", value: stats.summary.hitRate, color: "text-emerald-400" },
              { label: "Hits", value: stats.summary.hits, color: "text-emerald-400" },
              { label: "Misses", value: stats.summary.misses, color: "text-amber-400" },
              { label: "Requests", value: stats.summary.totalRequests, color: "text-blue-400" },
            ].map(({ label, value, color }) => (
              <div
                key={label}
                className="bg-white/5 border border-white/10 rounded-xl p-4"
              >
                <div className="text-xs text-gray-400 mb-1">{label}</div>
                <div className={"text-2xl font-bold " + color}>{value}</div>
              </div>
            ))}
          </div>

          {/* Hit rate bar */}
          <div className="mb-8 bg-white/5 border border-white/10 rounded-xl p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-400">Cache Hit Rate</span>
              <span className="text-sm font-bold text-emerald-400">
                {stats.summary.hitRate}
              </span>
            </div>
            <div className="h-4 w-full bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full transition-all duration-500"
                style={{
                  width:
                    stats.summary.totalRequests > 0
                      ? (stats.summary.hits / stats.summary.totalRequests) * 100 + "%"
                      : "0%",
                }}
              />
            </div>
            <div className="flex justify-between mt-2 text-xs text-gray-500">
              <span>{stats.summary.hits} hits</span>
              <span>{stats.summary.misses} misses</span>
            </div>
          </div>

          {/* Domain breakdown table */}
          <div className="mb-8 bg-white/5 border border-white/10 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-white/10">
              <h2 className="text-sm font-semibold text-gray-300">
                Domain Breakdown
              </h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-white/5">
                  <th className="px-5 py-2 font-medium">Domain</th>
                  <th className="px-5 py-2 font-medium text-right">Hits</th>
                  <th className="px-5 py-2 font-medium text-right">Misses</th>
                  <th className="px-5 py-2 font-medium text-right">Sets</th>
                  <th className="px-5 py-2 font-medium text-right">Deletes</th>
                  <th className="px-5 py-2 font-medium text-right">Hit Rate</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(stats.domains).map(([domain, s]) => {
                  const total = s.hits + s.misses + s.forceFresh;
                  const rate =
                    total > 0 ? ((s.hits / total) * 100).toFixed(0) + "%" : "-";
                  return (
                    <tr
                      key={domain}
                      className="border-b border-white/5 hover:bg-white/5 transition-colors"
                    >
                      <td className="px-5 py-2.5 text-gray-200 capitalize">
                        {domain}
                      </td>
                      <td className="px-5 py-2.5 text-right text-emerald-400">
                        {s.hits}
                      </td>
                      <td className="px-5 py-2.5 text-right text-amber-400">
                        {s.misses}
                      </td>
                      <td className="px-5 py-2.5 text-right text-blue-400">
                        {s.sets}
                      </td>
                      <td className="px-5 py-2.5 text-right text-red-400">
                        {s.deletes}
                      </td>
                      <td className="px-5 py-2.5 text-right text-gray-300 font-medium">
                        {rate}
                      </td>
                    </tr>
                  );
                })}
                {Object.keys(stats.domains).length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-5 py-6 text-center text-gray-500"
                    >
                      No domain data yet. Make some cached requests first
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Mode info */}
          <div className="mb-8 flex gap-4 flex-wrap">
            <div className="bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-xs text-gray-400">
              Verbose logging:{" "}
              <span
                className={
                  stats.mode.verboseLogging === "enabled"
                    ? "text-green-400"
                    : "text-gray-500"
                }
              >
                {stats.mode.verboseLogging}
              </span>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-xs text-gray-400">
              Log filter:{" "}
              <span className="text-gray-300">{stats.mode.logFilter}</span>
            </div>
          </div>
        </>
      )}

      {/* Loading state */}
      {loading && !stats && (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-400 border-t-transparent" />
        </div>
      )}

      {/* Tab bar */}
      <div className="mb-6 flex gap-1 rounded-lg border border-white/10 bg-white/5 p-1 w-fit">
        {(["cache", "users", "audit", "reports", "messages", "reviews"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={
              "px-4 py-1.5 rounded-md text-sm font-medium transition-colors capitalize " +
              (activeTab === tab
                ? "bg-blue-500/30 text-blue-200"
                : "text-gray-400 hover:text-gray-200")
            }
          >
            <span className="inline-flex items-center gap-1.5">{tab === "cache" ? <><IconChartBar size={14} /> Cache</> : tab === "users" ? <><IconUsers size={14} /> Users</> : tab === "audit" ? <><IconClipboardList size={14} /> Audit Logs</> : tab === "reports" ? <><IconFlag size={14} /> Reports{reportNotifCount > 0 && <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white">{reportNotifCount > 9 ? "9+" : reportNotifCount}</span>}</> : tab === "messages" ? <><IconMail size={14} /> Messages{messageNotifCount > 0 && <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white">{messageNotifCount > 9 ? "9+" : messageNotifCount}</span>}</> : <><IconStar size={14} /> Reviews</>}</span>
          </button>
        ))}
      </div>

      {/* ── Cache Tab ────────────────────────────────────────────── */}
      {activeTab === "cache" && (
        <>
          {/* Actions */}
          <div className="bg-white/5 border border-white/10 rounded-xl p-6 space-y-5">
            <h2 className="text-lg font-semibold text-white">Actions</h2>

            {/* Maintenance-mode kill switch */}
            <div className="border-b border-white/10 pb-4 mb-4">
              <label className="block text-sm text-gray-400 mb-2">
                Maintenance mode (kill switch)
              </label>
              {maintenanceMode ? (
                <div className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-300">
                  ⚠ Maintenance is ON — visitors are seeing the maintenance
                  page. You can still access this dashboard.
                </div>
              ) : null}
              <button
                onClick={handleToggleMaintenance}
                disabled={maintenanceLoading || actionLoading !== null || maintenanceMode === null}
                className={
                  "px-4 py-2 rounded-lg text-sm font-medium transition-colors border disabled:opacity-50 " +
                  (maintenanceMode
                    ? "bg-green-500/20 hover:bg-green-500/30 text-green-300 border-green-500/30"
                    : "bg-red-500/20 hover:bg-red-500/30 text-red-300 border-red-500/30")
                }
              >
                {maintenanceLoading
                  ? "Updating..."
                  : maintenanceMode
                    ? "Turn Maintenance OFF (bring site live)"
                    : "Turn Maintenance ON (kill switch)"}
              </button>
            </div>

            {/* Flush section */}
            <div>
              <label className="block text-sm text-gray-400 mb-2">
                Flush cache scope
              </label>
              <div className="flex flex-wrap gap-2 mb-3">
                {(["all", "leaderboards", "user-stats", "recent-games", "big-wins"] as FlushScope[]).map(
                  (s) => (
                    <button
                      key={s}
                      onClick={() => setFlushScope(s)}
                      className={
                        "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border " +
                        (flushScope === s
                          ? "bg-blue-500/20 border-blue-500/40 text-blue-300"
                          : "bg-white/5 border-white/10 text-gray-400 hover:text-gray-200")
                      }
                    >
                      {s}
                    </button>
                  ),
                )}
              </div>
              <button
                onClick={handleFlush}
                disabled={actionLoading !== null}
                className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {actionLoading === "flush" ? "Flushing..." : "Flush Cache (" + flushScope + ")"}
              </button>
            </div>

            {/* Reset section */}
            <div className="border-t border-white/10 pt-4">
              <label className="block text-sm text-gray-400 mb-3">
                Reset stats counters
              </label>
              <div className="flex gap-3">
                <button
                  onClick={() => handleReset(false)}
                  disabled={actionLoading !== null}
                  className="px-4 py-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                >
                  {actionLoading === "reset" ? "Resetting..." : "Reset Stats Only"}
                </button>
                <button
                  onClick={() => handleReset(true)}
                  disabled={actionLoading !== null}
                  className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                >
                  {actionLoading === "reset" ? "Resetting..." : "Reset Stats + Flush Cache"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Users Tab ────────────────────────────────────────────── */}
      {activeTab === "users" && (
        <div className="space-y-6">
          {/* Search */}
          <div className="bg-white/5 border border-white/10 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-4">
              User Management
            </h2>
            <div className="flex gap-3 mb-4">
              <button
                onClick={loadAdminTeam}
                disabled={userSearchLoading}
                className="px-4 py-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {userSearchLoading ? "Loading..." : <span className="inline-flex items-center gap-1.5"><IconSearch size={14} /> Load Admin Team</span>}
              </button>
            </div>
            <div className="flex gap-3">
              <label htmlFor="admin-user-search" className="sr-only">Search users</label>
              <input
                id="admin-user-search"
                type="text"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleUserSearch();
                }}
                className="flex-1 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-200 placeholder-gray-500 outline-none focus:border-blue-400/40"
              />
              <button
                onClick={handleUserSearch}
                disabled={userSearchLoading}
                className="px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 border border-blue-500/30 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {userSearchLoading ? "Searching..." : "Search"}
              </button>
            </div>

            {/* Results */}
            {searchedUsers.length > 0 && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-white/10">
                      <th className="px-3 py-2 font-medium">Name</th>
                      <th className="px-3 py-2 font-medium">Email</th>
                      <th className="px-3 py-2 font-medium">Clerk ID</th>
                      <th className="px-3 py-2 font-medium text-center">
                        Admin
                      </th>
                      <th className="px-3 py-2 font-medium text-right">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {searchedUsers.map((u) => (
                      <tr
                        key={u.clerkId}
                        className="border-b border-white/5 hover:bg-white/5 transition-colors"
                      >
                        <td className="px-3 py-2.5 text-gray-200 truncate max-w-[140px]">
                          {u.name}
                        </td>
                        <td className="px-3 py-2.5 text-gray-400 truncate max-w-[180px]">
                          {u.email}
                        </td>
                        <td className="px-3 py-2.5 text-gray-500 text-xs font-mono truncate max-w-[140px]">
                          {u.clerkId}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          {u.isAdmin ? (
                            <AdminBadge />
                          ) : (
                            <span className="inline-block w-2 h-2 rounded-full bg-gray-600" />
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="flex flex-col gap-1.5 items-end">
                            <button
                              onClick={() => handleToggleAdmin(u)}
                              disabled={userToggleLoading === u.clerkId}
                              className={
                                "px-3 py-1 rounded-lg text-xs font-medium transition-colors border disabled:opacity-50 " +
                                (u.isAdmin
                                  ? "bg-red-500/20 hover:bg-red-500/30 text-red-300 border-red-500/30"
                                  : "bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border-emerald-500/30")
                              }
                            >
                              {userToggleLoading === u.clerkId
                                ? "..."
                                : u.isAdmin
                                  ? "Revoke Admin"
                                  : "Make Admin"}
                            </button>
                            <button
                              onClick={() => {
                                setTokenResetTarget(u);
                                setTokenResetAmount("");
                              }}
                              className="px-3 py-1 rounded-lg text-[10px] font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 transition-colors"
                            >
                              <span className="inline-flex items-center gap-1"><IconCoins size={12} /> Reset Tokens</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* ── Token Reset Panel ── */}
            {tokenResetTarget && (
              <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-amber-300">
                    <span className="inline-flex items-center gap-1"><IconCoins size={14} /> Reset tokens for{" "}</span>
                    <span className="text-white">{tokenResetTarget.name}</span>
                    <span className="ml-2 text-xs text-gray-500 font-mono">
                      ({tokenResetTarget.clerkId})
                    </span>
                  </span>
                  <button
                    onClick={() => {
                      setTokenResetTarget(null);
                      setTokenResetAmount("");
                    }}
                    className="text-xs text-gray-500 hover:text-gray-300"
                  >
                    <span className="inline-flex items-center gap-1"><IconX size={12} /> Cancel</span>
                  </button>
                </div>
                <div className="flex gap-3">
                  <label htmlFor="admin-token-reset-amount" className="sr-only">New token balance</label>
                  <input
                    id="admin-token-reset-amount"
                    type="number"
                    value={tokenResetAmount}
                    onChange={(e) => setTokenResetAmount(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleResetTokens();
                    }}
                    className="flex-1 rounded-lg border border-amber-500/30 bg-white/5 px-4 py-2 text-sm text-gray-200 placeholder-gray-500 outline-none focus:border-amber-400/50"
                    min={0}
                    step="any"
                  />
                  <button
                    onClick={handleResetTokens}
                    disabled={tokenResetLoading || !tokenResetAmount.trim()}
                    className="px-5 py-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    {tokenResetLoading ? "Setting..." : "Set Balance"}
                  </button>
                </div>
              </div>
            )}

            {searchedUsers.length === 0 && userSearch && !userSearchLoading && (
              <p className="mt-4 text-sm text-gray-500 text-center">
                No users found matching &quot;{userSearch}&quot;.
              </p>
            )}

            {userSearchLoading && (
              <div className="mt-4 flex justify-center">
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-blue-400 border-t-transparent" />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Reports Tab ──────────────────────────────────────────── */}
      {activeTab === "reports" && (
        <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">
              Player Reports
            </h2>
            <button
              onClick={fetchReports}
              disabled={reportsLoading}
              className="px-3 py-1.5 bg-white/10 hover:bg-white/20 text-gray-300 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
            >
              {reportsLoading ? "Loading..." : <span className="inline-flex items-center gap-1.5"><IconRefresh size={14} /> Refresh</span>}
            </button>
          </div>

          {reportsLoading && reports.length === 0 && (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-400 border-t-transparent" />
            </div>
          )}

          {!reportsLoading && reports.length === 0 && (
            <div className="py-16 text-center text-gray-500 text-sm">
              No pending reports. All clear!
            </div>
          )}

          {reports.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-white/5">
                    <th className="px-3 py-2.5 font-medium">ID</th>
                    <th className="px-3 py-2.5 font-medium">Reported</th>
                    <th className="px-3 py-2.5 font-medium">Reason</th>
                    <th className="px-3 py-2.5 font-medium">Game</th>
                    <th className="px-3 py-2.5 font-medium">Reporter</th>
                    <th className="px-3 py-2.5 font-medium">Time</th>
                    <th className="px-3 py-2.5 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-white/5 hover:bg-white/5 transition-colors"
                    >
                      <td className="px-3 py-2.5 text-gray-300 font-mono text-xs">
                        #{r.id}
                      </td>
                      <td className="px-3 py-2.5">
                        <div>
                          <span className="text-gray-200 font-medium">{r.reported_name || r.reported_clerk_id}</span>
                          {r.reported_is_banned && (
                            <span className="ml-1.5 inline-flex items-center rounded-full bg-red-500/20 border border-red-500/30 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
                              BANNED
                            </span>
                          )}
                        </div>
                        {r.reported_email && (
                          <p className="text-gray-500 text-[10px]">{r.reported_email}</p>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center rounded-full bg-orange-500/15 border border-orange-500/30 px-2 py-0.5 text-[11px] font-medium text-orange-300">
                          {formatReason(r.reason)}
                        </span>
                        {r.details && (
                          <p className="text-gray-500 text-[10px] mt-1 max-w-[150px] truncate" title={r.details}>
                            {r.details}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-gray-400 text-xs capitalize">
                        {r.game_type.replace(/-/g, " ")}
                        {r.game_id && <span className="text-gray-600"> #{r.game_id}</span>}
                      </td>
                      <td className="px-3 py-2.5 text-gray-400 text-xs">
                        {r.reporter_name || r.reporter_clerk_id}
                      </td>
                      <td className="px-3 py-2.5 text-gray-500 text-xs font-mono whitespace-nowrap">
                        {formatTimestamp(r.created_at)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => handleToggleBan(r.reported_clerk_id, !r.reported_is_banned)}
                            disabled={banLoading === r.reported_clerk_id}
                            className={
                              "px-2.5 py-1 rounded text-[10px] font-medium transition-colors border disabled:opacity-50 " +
                              (r.reported_is_banned
                                ? "bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border-emerald-500/30"
                                : "bg-red-500/20 hover:bg-red-500/30 text-red-300 border-red-500/30")
                            }
                          >
                            {banLoading === r.reported_clerk_id
                              ? "..."
                              : r.reported_is_banned
                                ? "Unban"
                                : "Ban"}
                          </button>
                          <button
                            onClick={() => handleResolveReport(r.id, "dismissed")}
                            disabled={banLoading === String(r.id)}
                            className="px-2.5 py-1 rounded text-[10px] font-medium bg-white/5 hover:bg-white/10 text-gray-400 border border-white/10 transition-colors disabled:opacity-50"
                          >
                            Dismiss
                          </button>
                          <button
                            onClick={() => handleResolveReport(r.id, "resolved")}
                            disabled={banLoading === String(r.id)}
                            className="px-2.5 py-1 rounded text-[10px] font-medium bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/20 transition-colors disabled:opacity-50"
                          >
                            Resolve
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Messages Tab ─────────────────────────────────────────── */}
      {activeTab === "messages" && (
        <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">
              Contact Messages
            </h2>
            <button
              onClick={fetchMessages}
              disabled={messagesLoading}
              className="px-3 py-1.5 bg-white/10 hover:bg-white/20 text-gray-300 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
            >
              {messagesLoading ? "Loading..." : <span className="inline-flex items-center gap-1.5"><IconRefresh size={14} /> Refresh</span>}
            </button>
          </div>

          {messagesLoading && messages.length === 0 && (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-400 border-t-transparent" />
            </div>
          )}

          {!messagesLoading && messages.length === 0 && (
            <div className="py-16 text-center text-gray-500 text-sm">
              No contact messages yet. Messages from the contact form will
              appear here.
            </div>
          )}

          {messages.map((m) => (
            <div
              key={m.id}
              className="border-b border-white/5 hover:bg-white/5 transition-colors p-5"
            >
              {/* Header: id, from, status */}
              <div className="flex items-start justify-between gap-4 mb-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-gray-500 font-mono text-xs mt-1">
                    #{m.id}
                  </span>
                  <div className="min-w-0">
                    <div className="text-gray-200 font-medium truncate">
                      {m.name || "Anonymous"}
                    </div>
                    <a
                      href={"mailto:" + m.email}
                      className="text-[#c9f7ff]/60 text-[10px] hover:text-[#f5ff3b] transition-colors"
                    >
                      {m.email}
                    </a>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-gray-500 text-xs font-mono">
                    {formatTimestamp(m.created_at)}
                  </span>
                  {m.status === "new" ? (
                    <span className="inline-flex items-center rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[11px] font-medium text-amber-300">
                      NEW
                    </span>
                  ) : m.status === "replied" ? (
                    <span className="inline-flex items-center rounded-full bg-blue-500/15 border border-blue-500/30 px-2 py-0.5 text-[11px] font-medium text-blue-300">
                      REPLIED
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                      RESOLVED
                    </span>
                  )}
                </div>
              </div>

              {/* Message body */}
              <p className="text-gray-300 text-sm whitespace-pre-wrap break-words">
                {m.message}
              </p>

              {/* Replies */}
              {m.replies && m.replies.length > 0 && (
                <div className="mt-4 space-y-3 border-t border-white/10 pt-4">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Replies
                  </p>
                  {m.replies.map((r) => (
                    <div
                      key={r.id}
                      className="bg-[#0e1f4d]/60 border border-white/10 rounded-lg p-3"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-[#f5ff3b]">
                          {r.admin_name}
                        </span>
                        <AdminBadge />
                        <span className="text-gray-500 text-[10px] font-mono">
                          {formatTimestamp(r.created_at)}
                        </span>
                      </div>
                      <p className="text-gray-200 text-sm whitespace-pre-wrap break-words">
                        {r.reply}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* Actions */}
              <div className="mt-4 flex items-center gap-2">
                <button
                  onClick={() => {
                    setReplyTarget(m);
                    setReplyText("");
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#f5ff3b]/10 hover:bg-[#f5ff3b]/20 text-[#f5ff3b] border border-[#f5ff3b]/30 transition-colors"
                >
                  <span className="inline-flex items-center gap-1.5"><IconMail size={12} /> Respond</span>
                </button>
                <button
                  onClick={() => handleSetMessageStatus(m.id, "resolved")}
                  disabled={messageActionLoading === String(m.id)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/20 transition-colors disabled:opacity-50"
                >
                  {messageActionLoading === String(m.id) ? "..." : "Mark Resolved"}
                </button>
                {m.status !== "new" && (
                  <button
                    onClick={() => handleSetMessageStatus(m.id, "new")}
                    disabled={messageActionLoading === String(m.id)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 text-gray-400 border border-white/10 transition-colors disabled:opacity-50"
                  >
                    {messageActionLoading === String(m.id) ? "..." : "Reopen"}
                  </button>
                )}
                <button
                  onClick={() => handleDeleteMessage(m)}
                  disabled={messageActionLoading === "delete-" + m.id}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/30 transition-colors disabled:opacity-50 ml-auto"
                >
                  {messageActionLoading === "delete-" + m.id ? "..." : "Delete"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Reply modal ──────────────────────────────────────────── */}
      {replyTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setReplyTarget(null)}
        >
          <div
            className="w-full max-w-lg bg-[#0a0f1e] border border-white/15 rounded-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-semibold text-white">
                Reply to #{replyTarget.id}
              </h3>
              <button
                onClick={() => setReplyTarget(null)}
                className="text-gray-500 hover:text-gray-300"
              >
                <IconX size={18} />
              </button>
            </div>
            <p className="text-sm text-gray-400 mb-4">
              From:{" "}
              <span className="text-gray-200">
                {replyTarget.name || "Anonymous"}
              </span>{" "}
              <a
                href={"mailto:" + replyTarget.email}
                className="text-[#c9f7ff]/60 hover:text-[#f5ff3b] transition-colors"
              >
                {replyTarget.email}
              </a>
            </p>
            <div className="mb-4 rounded-lg bg-white/5 border border-white/10 p-3 text-sm text-gray-300 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
              {replyTarget.message}
            </div>
            <label htmlFor="admin-reply-text" className="sr-only">
              Reply message
            </label>
            <textarea
              id="admin-reply-text"
              rows={5}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Write your reply..."
              maxLength={5000}
              className="w-full rounded-lg border border-white/10 bg-[#0d1830] px-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none focus:border-[#f5ff3b]/50 resize-y mb-3"
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-gray-500">
                Replying as{" "}
                <span className="text-gray-300">
                  {user?.fullName || user?.username || "Admin"}
                </span>{" "}
                <AdminBadge />
              </span>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => setReplyTarget(null)}
                  disabled={replySending}
                  className="px-4 py-2 rounded-lg text-sm text-gray-400 border border-white/10 hover:bg-white/5 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSendReply}
                  disabled={replySending || !replyText.trim()}
                  className="px-4 py-2 rounded-lg text-sm font-semibold bg-[#f5ff3b] text-[#0a0f1e] hover:bg-[#f5ff3b]/90 transition-colors disabled:opacity-50"
                >
                  {replySending ? "Sending..." : "Send Reply"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Reviews Tab ──────────────────────────────────────────── */}
      {activeTab === "reviews" && (
        <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-lg font-semibold text-white">
              Product Reviews
            </h2>
            <div className="flex items-center gap-2">
              <div className="flex gap-1 rounded-lg border border-white/10 bg-white/5 p-1">
                {["pending", "approved", "rejected"].map((s) => (
                  <button
                    key={s}
                    onClick={() => setReviewFilter(s)}
                    className={
                      "px-3 py-1 rounded-md text-xs font-medium transition-colors capitalize " +
                      (reviewFilter === s
                        ? "bg-blue-500/30 text-blue-200"
                        : "text-gray-400 hover:text-gray-200")
                    }
                  >
                    {s}
                  </button>
                ))}
              </div>
              <button
                onClick={fetchReviews}
                disabled={reviewsLoading}
                className="px-3 py-1.5 bg-white/10 hover:bg-white/20 text-gray-300 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
              >
                {reviewsLoading ? "Loading..." : "Refresh"}
              </button>
            </div>
          </div>

          {reviewsLoading && reviews.length === 0 && (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-400 border-t-transparent" />
            </div>
          )}

          {!reviewsLoading && reviews.length === 0 && (
            <div className="py-16 text-center text-gray-500 text-sm">
              No {reviewFilter} reviews.
            </div>
          )}

          {reviews.map((r) => (
            <div key={r.id} className="border-b border-white/5 hover:bg-white/5 transition-colors p-5">
              <div className="flex items-start justify-between gap-4 mb-2">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-gray-500 font-mono text-xs mt-1">#{r.id}</span>
                  <div className="min-w-0">
                    <div className="text-gray-200 font-medium">
                      {r.username || "Unknown"}{" "}
                      <span className="text-[#f5ff3b]">{"★".repeat(r.rating)}</span>
                      <span className="text-white/20">{"★".repeat(5 - r.rating)}</span>
                    </div>
                    <div className="text-[#c9f7ff]/50 text-[10px]">
                      {r.email} · {r.game || "platform"} · {formatTimestamp(r.createdAt)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {r.status === "pending" && (
                    <>
                      <button
                        onClick={() => handleModerateReview(r.id, "approved")}
                        disabled={reviewActionLoading !== null}
                        className="px-3 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-300 border border-green-500/30 rounded-lg text-xs font-medium disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => handleModerateReview(r.id, "rejected")}
                        disabled={reviewActionLoading !== null}
                        className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30 rounded-lg text-xs font-medium disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => handleModerateReview(r.id, "delete")}
                    disabled={reviewActionLoading !== null}
                    className="px-3 py-1.5 bg-white/5 hover:bg-red-500/20 text-gray-400 hover:text-red-300 border border-white/10 rounded-lg text-xs font-medium disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
              {r.title && <div className="text-gray-200 font-semibold mb-1">{r.title}</div>}
              {r.body && <div className="text-gray-300 text-sm leading-relaxed">{r.body}</div>}
              {r.status !== "pending" && (
                <div className="mt-2 text-[11px] text-gray-500">
                  Status: <span className="text-gray-300 capitalize">{r.status}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Audit Logs Tab ────────────────────────────────────────── */}
      {activeTab === "audit" && (
        <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">
              Recent Admin Actions
            </h2>
            <button
              onClick={() => fetchAuditLogs(50)}
              disabled={auditLogLoading}
              className="px-3 py-1.5 bg-white/10 hover:bg-white/20 text-gray-300 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
            >
              {auditLogLoading ? "Loading..." : <span className="inline-flex items-center gap-1.5"><IconRefresh size={14} /> Refresh</span>}
            </button>
          </div>

          {auditLogLoading && auditLogs.length === 0 && (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-400 border-t-transparent" />
            </div>
          )}

          {!auditLogLoading && auditLogs.length === 0 && (
            <div className="py-16 text-center text-gray-500 text-sm">
              No audit log entries yet. Admin actions will appear here as they happen.
            </div>
          )}

          {auditLogs.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-white/5">
                    <th className="px-4 py-2.5 font-medium w-[130px]">Time</th>
                    <th className="px-4 py-2.5 font-medium w-[120px]">Event</th>
                    <th className="px-4 py-2.5 font-medium">By</th>
                    <th className="px-4 py-2.5 font-medium">Target</th>
                    <th className="px-4 py-2.5 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.map((log) => (
                    <tr
                      key={log.id}
                      className="border-b border-white/5 hover:bg-white/5 transition-colors"
                    >
                      <td className="px-4 py-2.5 text-gray-500 text-xs font-mono whitespace-nowrap">
                        {formatTimestamp(log.createdAt)}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center rounded-full bg-blue-500/15 border border-blue-500/30 px-2 py-0.5 text-[11px] font-medium text-blue-300 capitalize">
                          {formatEventName(log.event)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-gray-400 text-xs font-mono truncate max-w-[120px]">
                        {log.clerkId}
                      </td>
                      <td className="px-4 py-2.5 text-gray-400 text-xs font-mono truncate max-w-[120px]">
                        {log.targetClerkId || "-"}
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 text-xs truncate max-w-[180px]">
                        {JSON.stringify(log.details)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
