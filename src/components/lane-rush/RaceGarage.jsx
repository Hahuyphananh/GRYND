"use client";

// src/components/lane-rush/RaceGarage.jsx
//
// The player's fleet panel: every owned car as a coloured dot + tier card, with
// the planning controls the rules actually allow.
//
// ALL of it is presentation over the authoritative state the server sends
// (`myCars`, `myResources`, `actionPoints`, `phase`, `locked`). Each button
// sends an engine action through the match page; the server validates it and
// the next payload re-renders this panel. Nothing here mutates a car, a
// resource or a score.
//
// The two micro-animations are driven by confirmed data:
//   * a newly purchased car (a car id that was not in the previous payload)
//     pops in — `AnimatePresence` keys on the server's car id;
//   * a merge is replayed only after the action succeeded (`mergeAnim`), and
//     the merged dot is the real car the payload now contains.

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  IconBolt,
  IconCheck,
  IconCoins,
  IconLock,
  IconRefresh,
  IconRocket,
  IconShoppingCart,
  IconSparkles,
  IconTarget,
} from "@tabler/icons-react";
import {
  ACTION_POINTS_PER_ROUND,
  BUY_COST,
  MAX_OWNED_CARS,
  MAX_RACING_CARS,
  MERGE_COST,
  REPAIR_COST,
  ROUTES,
  ROUTE_IDS,
  mergedTier,
  tierName,
} from "../../lib/lane-rush/rules";

const SEAT_DOT = {
  player1: { fill: "#38bdf8", edge: "#e0f2fe", glow: "rgba(56,189,248,0.6)" },
  player2: { fill: "#fb7185", edge: "#ffe4e6", glow: "rgba(251,113,133,0.6)" },
};

const DOT_SIZE = { 1: 10, 2: 12, 3: 15, 4: 18 };

/** The HTML twin of the track dot: same seat colour, same tier scale. */
export function FleetDot({ tier, seat = "player1", dim = false }) {
  const colors = SEAT_DOT[seat] || SEAT_DOT.player1;
  const size = DOT_SIZE[tier] || DOT_SIZE[1];
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center"
      style={{ opacity: dim ? 0.55 : 1 }}
    >
      <span
        className="absolute rounded-full"
        style={{
          width: size,
          height: size,
          background: colors.fill,
          border: `1.5px solid ${colors.edge}`,
          boxShadow: `0 0 10px ${colors.glow}`,
        }}
      />
      {tier >= 2 && (
        <span
          className="absolute rounded-full"
          style={{
            width: Math.max(3, size - 5),
            height: Math.max(3, size - 5),
            border: `1px solid ${colors.edge}`,
            opacity: 0.7,
          }}
        />
      )}
      {tier >= 3 && (
        <span className="relative text-[8px] font-black text-slate-900">{tier}</span>
      )}
    </span>
  );
}

function Chip({ children, className = "" }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-bold ${className}`}
    >
      {children}
    </span>
  );
}

function RouteChips({ car, disabled, disabledReason, onRoute }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ROUTE_IDS.map((route) => {
        const config = ROUTES[route];
        const active = car.route === route && car.status === "racing";
        return (
          <button
            key={route}
            type="button"
            onClick={() => onRoute(car.id, route)}
            disabled={disabled}
            title={disabled ? disabledReason : `${config.blurb} — ${config.name}`}
            aria-pressed={active}
            className={`rounded-lg border px-2 py-1 text-[10px] font-black uppercase tracking-wide transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-40 ${
              active
                ? "border-cyan-300/80 bg-cyan-400/20 text-cyan-50"
                : "border-white/15 bg-white/[0.04] text-white/65 hover:border-cyan-300/50 hover:text-white"
            }`}
          >
            {config.name.replace(" Circuit", "").replace(" Lane", "").replace(" Route", "")}
            <span className="ml-1 font-semibold normal-case tracking-normal text-white/45">
              {config.pointsMultiplier}×
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function RaceGarage({
  cars = [],
  resources = { scrap: 0, fuel: 0, tech: 0 },
  actionPoints = 0,
  phase = null,
  locked = false,
  canPlan = false,
  acting = false,
  selectedCarId = null,
  onSelectCar = () => {},
  mergeSelection = [],
  onToggleMerge = () => {},
  onDeploy = () => {},
  onSetRoute = () => {},
  onRecall = () => {},
  onRepair = () => {},
  onBuy = () => {},
  onMerge = () => {},
  onWorkshopRecovery = () => {},
  mergeAnim = null,
  seat = "player1",
}) {
  const reduced = Boolean(useReducedMotion());
  const [newCarIds, setNewCarIds] = useState([]);
  const previousIdsRef = useRef(null);

  // A car that was not in the previous payload is a confirmed purchase (or
  // merge). The first payload after mount is a baseline, never "news".
  useEffect(() => {
    const ids = cars.map((car) => car.id);
    if (previousIdsRef.current === null) {
      previousIdsRef.current = ids;
      return;
    }
    const added = ids.filter((id) => !previousIdsRef.current.includes(id));
    previousIdsRef.current = ids;
    if (added.length > 0) setNewCarIds(added);
  }, [cars]);
  // Its OWN timer, so a payload arriving mid-glow does not cancel the reset.
  useEffect(() => {
    if (newCarIds.length === 0) return undefined;
    const timer = setTimeout(() => setNewCarIds([]), 900);
    return () => clearTimeout(timer);
  }, [newCarIds]);

  const owned = cars.length;
  const racing = cars.filter((car) => car.status === "racing").length;
  const scrap = Number(resources?.scrap) || 0;
  const fuel = Number(resources?.fuel) || 0;
  const tech = Number(resources?.tech) || 0;
  const ap = Number(actionPoints) || 0;

  const planningOpen = canPlan && phase === "planning" && !locked && !acting;
  const closedReason = locked
    ? "Your plan is locked in"
    : phase !== "planning"
      ? "Planning is closed"
      : !canPlan
        ? "Waiting for the race to finish"
        : acting
          ? "Sending your plan…"
          : "";

  const mergeTier = (() => {
    if (mergeSelection.length !== 2) return null;
    const pair = mergeSelection
      .map((id) => cars.find((car) => car.id === id))
      .filter(Boolean);
    if (pair.length !== 2) return null;
    if (pair[0].tier !== pair[1].tier) return null;
    return pair[0].tier;
  })();
  const mergeTarget = mergeTier ? mergedTier(mergeTier) : null;

  const canMerge = Boolean(
    planningOpen && mergeTarget && ap >= MERGE_COST.actionPoints,
  );
  const mergeReason = !planningOpen
    ? closedReason
    : !mergeTarget
      ? "Select two identical-tier garage cars"
      : ap < MERGE_COST.actionPoints
        ? "Not enough action points"
        : "";

  const fleetFull = owned >= MAX_OWNED_CARS;
  const canBuy = Boolean(planningOpen && !fleetFull && scrap >= BUY_COST.scrap && ap >= BUY_COST.actionPoints);
  const buyReason = !planningOpen
    ? closedReason
    : fleetFull
      ? `Fleet is full (${MAX_OWNED_CARS} cars)`
      : scrap < BUY_COST.scrap
        ? `Needs ${BUY_COST.scrap} Scrap`
        : ap < BUY_COST.actionPoints
          ? "Not enough action points"
          : "";

  const gridFull = racing >= MAX_RACING_CARS;
  const damagedCars = cars.filter((car) => car.damaged && car.status === "garage");
  const softLocked =
    planningOpen && scrap === 0 && cars.length > 0 && cars.every((car) => car.damaged);

  const ordered = [...cars].sort((a, b) => {
    const statusRank = (car) =>
      car.status === "racing" ? 0 : car.status === "garage" ? 1 : 2;
    if (statusRank(a) !== statusRank(b)) return statusRank(a) - statusRank(b);
    if (a.tier !== b.tier) return b.tier - a.tier;
    return a.id.localeCompare(b.id);
  });

  const mergePair = mergeSelection
    .map((id) => cars.find((car) => car.id === id))
    .filter(Boolean);

  return (
    <section
      aria-label="Your fleet"
      className="relative overflow-hidden rounded-2xl border border-white/10 bg-slate-950/60 p-3 backdrop-blur-md"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <IconTarget size={15} className="text-cyan-300" />
          <h2 className="text-xs font-black uppercase tracking-[0.18em] text-cyan-100">
            Your fleet
          </h2>
          <span className="text-[10px] font-semibold text-white/45">
            {owned}/{MAX_OWNED_CARS} cars · {racing}/{MAX_RACING_CARS} racing
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Chip className="text-slate-200">
            <IconBolt size={12} className="text-[#f5ff3b]" />
            {ap} AP
          </Chip>
          <Chip className="text-slate-200">
            <IconCoins size={12} className="text-yellow-300" />
            {scrap} Scrap
          </Chip>
          <Chip className="text-slate-200">
            <IconRocket size={12} className="text-sky-300" />
            {fuel} Fuel
          </Chip>
          <Chip className="text-slate-200">
            <IconSparkles size={12} className="text-fuchsia-300" />
            {tech} Tech
          </Chip>
        </div>
      </header>

      {/* Action points as pips, so the remaining budget is obvious at a glance. */}
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-white/45">
          Action points
        </span>
        <span className="flex items-center gap-1">
          {Array.from({ length: ACTION_POINTS_PER_ROUND }, (_, i) => (
            <span
              key={i}
              className={`h-2 w-5 rounded-full ${
                i < ap ? "bg-[#f5ff3b] shadow-[0_0_8px_rgba(245,255,59,0.6)]" : "bg-white/15"
              }`}
            />
          ))}
        </span>
        <span className="text-[10px] font-semibold text-white/40">
          {ap}/{ACTION_POINTS_PER_ROUND} left
        </span>
      </div>

      {/* Merge replay: two confirmed dots converge, then the new tier appears. */}
      <AnimatePresence>
        {mergeAnim && (
          <motion.div
            key={mergeAnim.key}
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-x-0 top-16 z-20 flex h-16 items-center justify-center gap-0"
            aria-hidden="true"
          >
            <motion.span
              initial={reduced ? false : { x: -46, opacity: 0, scale: 0.9 }}
              animate={{ x: -12, opacity: 1, scale: 1 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
            >
              <FleetDot tier={mergeAnim.tier} seat={seat} />
            </motion.span>
            <motion.span
              initial={reduced ? false : { x: 46, opacity: 0, scale: 0.9 }}
              animate={{ x: 12, opacity: 1, scale: 1 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
            >
              <FleetDot tier={mergeAnim.tier} seat={seat} />
            </motion.span>
            <motion.span
              initial={reduced ? false : { scale: 0.2, opacity: 0 }}
              animate={{ scale: [0.2, 1.6, 1], opacity: 1 }}
              transition={{ delay: 0.36, duration: 0.5, ease: "easeOut" }}
              className="ml-1"
            >
              <FleetDot tier={mergeAnim.tier + 1} seat={seat} />
            </motion.span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Buy + merge tools. */}
      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          data-testid="lane-runner-buy"
          onClick={onBuy}
          disabled={!canBuy}
          title={canBuy ? "Add a Tier 1 car to your garage" : buyReason}
          className="flex flex-1 items-center justify-between gap-2 rounded-xl border border-cyan-300/40 bg-cyan-400/10 px-3 py-2 text-left text-[11px] font-black uppercase tracking-wide text-cyan-100 transition hover:bg-cyan-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.03] disabled:text-white/40"
        >
          <span className="inline-flex items-center gap-1.5">
            <IconShoppingCart size={14} />
            Buy Tier 1 car
          </span>
          <span className="shrink-0 whitespace-nowrap text-[10px] font-bold normal-case tracking-normal text-white/50">
            {BUY_COST.scrap} Scrap · {BUY_COST.actionPoints} AP
          </span>
        </button>

        <button
          type="button"
          data-testid="lane-runner-merge"
          onClick={() => onMerge(mergeSelection)}
          disabled={!canMerge}
          title={canMerge ? "Merge the two selected cars" : mergeReason}
          className="flex flex-1 items-center justify-between gap-2 rounded-xl border border-fuchsia-300/40 bg-fuchsia-400/10 px-3 py-2 text-left text-[11px] font-black uppercase tracking-wide text-fuchsia-100 transition hover:bg-fuchsia-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-300 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.03] disabled:text-white/40"
        >
          <span className="inline-flex items-center gap-1.5">
            <IconSparkles size={14} />
            {mergeTarget
              ? `Merge → Tier ${mergeTarget} ${tierName(mergeTarget)}`
              : "Merge two cars"}
          </span>
          <span className="shrink-0 whitespace-nowrap text-[10px] font-bold normal-case tracking-normal text-white/50">
            {MERGE_COST.actionPoints} AP
          </span>
        </button>
      </div>
      {mergePair.length === 2 && (
        <p className="mt-1 text-[10px] font-semibold text-white/45">
          {mergeTarget
            ? `Two Tier ${mergeTier} cars selected — merging frees no slot and uses 1 AP.`
            : "Merges need two different cars of the SAME tier."}
        </p>
      )}

      {/* The fleet. */}
      <ul className="mt-3 grid grid-cols-1 gap-2">
        <AnimatePresence initial={false}>
          {ordered.map((car) => {
            const isRacing = car.status === "racing";
            const isRecovering = car.status === "recovering";
            const selectedForMerge = mergeSelection.includes(car.id);
            const canSelectForMerge = Boolean(
              planningOpen &&
                car.status === "garage" &&
                !car.damaged &&
                (mergedTier(car.tier) !== null),
            );
            const deployDisabled = !planningOpen || gridFull || acting;
            const deployReason = !planningOpen
              ? closedReason
              : gridFull
                ? `Only ${MAX_RACING_CARS} cars can race in a round`
                : "";
            const repairDisabled =
              !planningOpen || scrap < REPAIR_COST.scrap || ap < REPAIR_COST.actionPoints;
            const repairReason = !planningOpen
              ? closedReason
              : scrap < REPAIR_COST.scrap
                ? `Needs ${REPAIR_COST.scrap} Scrap`
                : "Not enough action points";
            const isNew = newCarIds.includes(car.id);

            return (
              <motion.li
                key={car.id}
                layout={!reduced}
                initial={reduced ? false : { opacity: 0, scale: isNew ? 0.6 : 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduced ? undefined : { opacity: 0, scale: 0.9 }}
                transition={{ type: "spring", stiffness: 320, damping: 26 }}
                onClick={() => onSelectCar(car.id)}
                className={`rounded-xl border p-2.5 transition ${
                  selectedCarId === car.id
                    ? "border-cyan-300/70 bg-cyan-400/10"
                    : selectedForMerge
                      ? "border-fuchsia-300/60 bg-fuchsia-400/[0.08]"
                      : "border-white/10 bg-white/[0.03]"
                } ${isNew ? "shadow-[0_0_22px_-4px_rgba(56,189,248,0.75)]" : ""}`}
              >
                <div className="flex items-start gap-2">
                  <FleetDot tier={car.tier} seat={seat} dim={isRecovering} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-black uppercase tracking-wide text-white">
                      {tierName(car.tier)}
                    </p>
                    <p className="text-[10px] font-semibold text-white/45">
                      Tier {car.tier} · {car.id}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {isRacing && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-cyan-300/40 bg-cyan-400/15 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-cyan-100">
                        <IconCheck size={10} /> Racing
                      </span>
                    )}
                    {car.damaged && (
                      <span className="rounded-full border border-rose-400/40 bg-rose-500/15 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-rose-200">
                        Damaged
                      </span>
                    )}
                    {isRecovering && (
                      <span className="rounded-full border border-amber-300/40 bg-amber-400/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-amber-200">
                        Workshop
                      </span>
                    )}
                    {!isRacing && !car.damaged && !isRecovering && (
                      <span className="rounded-full border border-white/15 bg-white/[0.04] px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-white/55">
                        Available
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-2 space-y-1.5">
                  {isRecovering ? (
                    <p className="text-[10px] font-semibold text-amber-200/80">
                      In the workshop — back in your garage next round.
                    </p>
                  ) : car.damaged ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onRepair(car.id);
                        }}
                        disabled={repairDisabled}
                        title={repairDisabled ? repairReason : "Repair this car"}
                        className="inline-flex items-center gap-1 rounded-lg border border-emerald-300/40 bg-emerald-400/10 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-emerald-100 transition hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <IconRefresh size={11} />
                        Repair {REPAIR_COST.scrap} Scrap · {REPAIR_COST.actionPoints} AP
                      </button>
                      <span className="text-[10px] font-semibold text-rose-200/75">
                        DNF — cannot race or merge
                      </span>
                    </div>
                  ) : isRacing ? (
                    <>
                      <RouteChips
                        car={car}
                        disabled={!planningOpen}
                        disabledReason={closedReason}
                        onRoute={onSetRoute}
                      />
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onRecall(car.id);
                        }}
                        disabled={!planningOpen}
                        title={planningOpen ? "Return this car to the garage" : closedReason}
                        className="rounded-lg border border-white/15 bg-white/[0.04] px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white/60 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Return to garage
                      </button>
                    </>
                  ) : (
                    <>
                      <RouteChips
                        car={car}
                        disabled={deployDisabled}
                        disabledReason={deployReason}
                        onRoute={(carId, route) => onDeploy(carId, route)}
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] font-semibold text-white/40">
                          Pick a lane to deploy
                        </span>
                        {canSelectForMerge && (
                          <label
                            className="inline-flex cursor-pointer items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-fuchsia-200/80"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              checked={selectedForMerge}
                              onChange={() => onToggleMerge(car.id)}
                              className="h-3 w-3 accent-fuchsia-400"
                            />
                            Merge
                          </label>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>

      {damagedCars.length > 0 && softLocked && (
        <button
          type="button"
          onClick={() => onWorkshopRecovery(damagedCars[0].id)}
          className="mt-2 w-full rounded-xl border border-amber-300/50 bg-amber-400/10 px-3 py-2 text-[10px] font-black uppercase tracking-wide text-amber-100 transition hover:bg-amber-400/20"
        >
          Free workshop recovery — ends your planning
        </button>
      )}

      {!cars.length && (
        <p className="mt-3 text-[11px] font-semibold text-white/50">
          No cars yet — buy a Tier 1 car to join the grid.
        </p>
      )}

      {locked && (
        <p className="mt-2 inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wide text-emerald-200">
          <IconLock size={11} /> Plan locked in — waiting for your rival
        </p>
      )}
    </section>
  );
}
