"use client";
import React from "react";
import TableCard from "./TableCard";

/**
 * TableList — responsive grid of TableCards.
 *
 * Props:
 *   tables  — array of table objects
 */
export default function TableList({ tables = [] }) {
  if (tables.length === 0) {
    return (
      <div className="rounded-2xl border border-[#00e5ff]/20 bg-[#040d24]/40 px-6 py-16 text-center">
        <p className="text-lg font-semibold text-[#d8fbff] opacity-90">No tables available</p>
        <p className="mt-2 text-sm text-[#9dd8ff] opacity-80">Check back soon for new tables.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4">
      {tables.map((table) => (
        <TableCard key={table.id} table={table} />
      ))}
    </div>
  );
}
