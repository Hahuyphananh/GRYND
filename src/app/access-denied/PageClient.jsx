"use client";

import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import { IconCircleX } from "@tabler/icons-react";
import { SignOutButton } from "../../components/SignOutButton";

export default function AccessDeniedPage() {
  return (
    <div className="relative min-h-screen bg-[#003366] flex items-center justify-center px-4">
      <InteractiveCasinoBg variant="subtle" />
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
        <div className="mb-4 flex justify-center"><IconCircleX size={56} className="text-red-500" /></div>
        <h1 className="text-2xl font-bold text-red-600 mb-4">Access Denied</h1>
        <p className="text-gray-700 mb-6">
          You must be at least 18 years old to access this gaming platform. This
          restriction is in place to comply with applicable regulations.
        </p>
        <div className="space-y-4">
          <SignOutButton>
            <button className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded">
              Sign Out
            </button>
          </SignOutButton>
          <p className="text-sm text-gray-500">
            If you believe this is an error, please contact support.
          </p>
        </div>
      </div>
    </div>
  );
}
