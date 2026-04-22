"use client";

import React from "react";
import { motion } from "framer-motion";

export const sportCardVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.22, ease: "easeOut" },
  },
};

export default function SportCard({ icon, name, onClick }) {
  return (
    <motion.button
      onClick={onClick}
      variants={sportCardVariants}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      className="inline-flex items-center space-x-3 rounded-lg border border-[#FFD700] bg-[#081a3d] px-6 py-4 shadow-lg shadow-[#FFD700]/20 transition-all hover:bg-[#081a3d]/90 hover:shadow-[#FFD700]/20"
    >
      <i className={`fas ${icon} text-2xl text-[#FFD700]`}></i>
      <span className="text-lg font-medium text-[#FFD700]">{name}</span>
    </motion.button>
  );
}
