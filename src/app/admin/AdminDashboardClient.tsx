"use client";

import { useState, useEffect, useCallback } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import AdminBadge from "../../components/AdminBadge";

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

  // ── User management state ──────────────────────────────────────
  const [userSearch, setUserSearch] = useState("");
  const [searchedUsers, setSearchedUsers] = useState<AdminUser[]>([]);
  const [userSearchLoading, setUserSearchLoading] = useState(false);
  const [userToggleLoading, setUserToggleLoading] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"cache" | "users" | "audit">("cache");
  const [adminVerified, setAdminVerified] = useState(initialAdminVerified);

  // ── Audit log state ────────────────────────────────────────────
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditLogLoading, setAuditLogLoading] = useState(false);

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
                    total > 0 ? ((s.hits / total) * 100).toFixed(0) + "%" : "—";
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
                      No domain data yet — make some cached requests first
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
        {(["cache", "users", "audit"] as const).map((tab) => (
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
            {tab === "cache" ? "📊 Cache" : tab === "users" ? "👥 Users" : "📋 Audit Logs"}
          </button>
        ))}
      </div>

      {/* ── Cache Tab ────────────────────────────────────────────── */}
      {activeTab === "cache" && (
        <>
          {/* Actions */}
          <div className="bg-white/5 border border-white/10 rounded-xl p-6 space-y-5">
            <h2 className="text-lg font-semibold text-white">Actions</h2>

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
                {userSearchLoading ? "Loading..." : "🔍 Load Admin Team"}
              </button>
            </div>
            <div className="flex gap-3">
              <input
                type="text"
                placeholder="Search by name, email, or Clerk ID..."
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
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
              {auditLogLoading ? "Loading..." : "🔄 Refresh"}
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
                        {log.targetClerkId || "—"}
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
