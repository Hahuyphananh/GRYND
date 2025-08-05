"use client";

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";

export default function CompleteProfilePage() {
  const { user } = useUser();
  const router = useRouter();
  const [birthDate, setBirthDate] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError("");

    if (!birthDate) {
      setError("Please enter your birth date");
      setIsSubmitting(false);
      return;
    }

    // Calculate age
    const age = Math.floor((Date.now() - new Date(birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    
    if (age < 18) {
      setError("You must be at least 18 years old to use this platform");
      setIsSubmitting(false);
      return;
    }

    try {

      console.log("Before update:", user.publicMetadata);
     const response = await fetch("/api/update-birthdate", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ birthDate }),
});

const result = await response.json();

if (!result.success) {
  throw new Error(result.error || "Unknown error");
}

console.log("Updated successfully.");

      router.push("/sync");
    } catch (err) {
      setError("Failed to update profile. Please try again.");
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#003366] flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-[#003366] mb-2">
            Complete Your Profile
          </h1>
          <p className="text-gray-600">
            We need to verify your age to comply with gambling regulations.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="birthDate" className="block text-sm font-medium text-gray-700 mb-2">
              Date of Birth
            </label>
            <input
              type="date"
              id="birthDate"
              value={birthDate}
              onChange={(e) => setBirthDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#003366]"
              required
            />
          </div>

          {error && (
            <div className="text-red-600 text-sm text-center">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-[#003366] hover:bg-[#003366]/90 text-white font-bold py-2 px-4 rounded disabled:opacity-50"
          >
            {isSubmitting ? "Updating..." : "Continue"}
          </button>
        </form>

        <p className="text-xs text-gray-500 text-center mt-4">
          Your information is secure and will only be used for age verification purposes.
        </p>
      </div>
    </div>
  );
}