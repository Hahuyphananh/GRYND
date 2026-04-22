"use client";

import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

const typeStyles = {
  success: "bg-green-500 text-white",
  error: "bg-red-500 text-white",
  info: "bg-[#f5ff3b] text-white",
  warning: "bg-yellow-500 text-white",
};

const icons = {
  success: "fa-check-circle",
  error: "fa-exclamation-circle",
  info: "fa-info-circle",
  warning: "fa-exclamation-triangle",
};

export default function NotificationToast({
  message,
  type = "info",
  duration = 5000,
  onClose,
  isVisible = true,
}) {
  const [show, setShow] = useState(isVisible);

  useEffect(() => {
    setShow(isVisible);
  }, [isVisible]);

  useEffect(() => {
    if (show && duration) {
      const timer = setTimeout(() => {
        setShow(false);
        onClose?.();
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [show, duration, onClose]);

  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          initial={{ opacity: 0, y: -8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className={`fixed right-4 top-4 z-50 flex items-center justify-between rounded-lg p-4 shadow-lg ${typeStyles[type]}`}
        >
          <div className="flex items-center space-x-2">
            <i className={`fas ${icons[type]}`}></i>
            <span className="text-sm font-medium">{message}</span>
          </div>
          <motion.button
            onClick={() => {
              setShow(false);
              onClose?.();
            }}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="ml-4 text-white hover:text-gray-200 focus:outline-none"
          >
            <i className="fas fa-times"></i>
          </motion.button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
