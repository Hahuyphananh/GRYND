"use client";
import React from "react";

export default function SportCard({ icon, name, onClick }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center space-x-3 rounded-lg border border-[#FFD700] bg-[#004080] px-6 py-4 shadow-lg shadow-[#FFD700]/20 transition-all hover:bg-[#004080]/90 hover:shadow-[#FFD700]/20"
    >
      <i className={`fas ${icon} text-2xl text-[#FFD700]`}></i>
      <span className="text-lg font-medium text-[#FFD700]">{name}</span>
    </button>
  );
}
