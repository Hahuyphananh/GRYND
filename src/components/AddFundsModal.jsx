"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useAuth } from "@clerk/nextjs";
import { modalMotion, withReducedMotion, hoverScale } from "../lib/animations";
import { UIPro17ModalBackdrop, UIPro18ModalPanel, UIPro19Input, UIPro21IconButton } from "./uipro";
import { useTranslation } from "../hooks/useTranslation";

export default function AddFundsModal({ isOpen, onClose, onSuccess }) {
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { getToken } = useAuth();
  const shouldReduceMotion = useReducedMotion();
  const { t } = useTranslation();

  const backdropVariant = withReducedMotion(shouldReduceMotion, modalMotion.backdrop);
  const panelVariant = withReducedMotion(shouldReduceMotion, modalMotion.panel);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const numAmount = parseFloat(amount);

    if (!numAmount || numAmount < 5 || numAmount > 500) {
      setError(t("ui.amount_range_error"));
      setLoading(false);
      return;
    }

    try {
      const token = await getToken();
      const response = await fetch("/api/tokens/add-funds", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ amount: numAmount }),
      });

      const data = await response.json();

      if (data.success) {
        onSuccess(data.newBalance);
        setAmount("");
        onClose();
      } else {
        setError(data.error || t("ui.add_funds_failed"));
      }
    } catch {
      setError(`${t("nav.network_error")}. ${t("ui.try_again")}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <UIPro17ModalBackdrop className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
          <motion.div initial={backdropVariant.initial} animate={backdropVariant.animate} exit={backdropVariant.exit} transition={backdropVariant.transition} className="absolute inset-0" onClick={onClose} />
          <motion.div initial={panelVariant.initial} animate={panelVariant.animate} exit={panelVariant.exit} transition={panelVariant.transition} className="relative z-10 w-full max-w-md">
            <UIPro18ModalPanel className="w-full rounded-lg bg-white p-6 shadow-xl">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-xl font-bold text-gray-800">{t("ui.add_funds")}</h2>
                <UIPro21IconButton onClick={onClose} className="text-2xl text-gray-500 hover:text-gray-700">×</UIPro21IconButton>
              </div>

              <form onSubmit={handleSubmit}>
                <div className="mb-4">
                  <label className="mb-2 block text-sm font-medium text-gray-700">{t("ui.amount_usd")}</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 transform text-gray-500">$</span>
                    <UIPro19Input
                      type="number"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="5.00"
                      min="5"
                      max="500"
                      step="0.01"
                      className="w-full rounded-lg border border-gray-300 py-2 pl-8 pr-4 focus:border-transparent focus:ring-2 focus:ring-blue-500"
                      required
                    />
                  </div>
                  <p className="mt-1 text-xs text-gray-500">{t("ui.min_max")}</p>
                </div>

                {error && <div className="mb-4 rounded border border-red-400 bg-red-100 p-3 text-red-700">{error}</div>}

                <div className="flex gap-3">
                  <motion.button type="button" onClick={onClose} className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50" whileHover={shouldReduceMotion ? undefined : hoverScale.whileHover} whileTap={shouldReduceMotion ? undefined : hoverScale.whileTap} transition={hoverScale.transition}>
                    {t("ui.cancel")}
                  </motion.button>
                  <motion.button type="submit" disabled={loading} className="flex-1 rounded-lg bg-green-600 px-4 py-2 text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50" whileHover={shouldReduceMotion ? undefined : hoverScale.whileHover} whileTap={shouldReduceMotion ? undefined : hoverScale.whileTap} transition={hoverScale.transition}>
                    {loading ? t("ui.processing") : t("ui.add_funds_action")}
                  </motion.button>
                </div>
              </form>

              <div className="mt-4 rounded border border-yellow-200 bg-yellow-50 p-3">
                <p className="text-xs text-yellow-800">{t("ui.secure_transaction")}</p>
              </div>
            </UIPro18ModalPanel>
          </motion.div>
        </UIPro17ModalBackdrop>
      )}
    </AnimatePresence>
  );
}
