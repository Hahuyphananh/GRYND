import type { Metadata } from "next";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";

export const metadata: Metadata = {
  title: "Shop | GRYND",
  description: "Grynd Shop",
};

const EMOTES = [
  ["gg", "GG", "Good Game", "text-[#f5ff3b]"],
  ["nice-move", "NICE MOVE", "Nice Move", "text-[#00e5ff]"],
  ["laugh", "😂", "Laugh", ""],
  ["wow", "😮", "Wow", ""],
  ["fire", "🔥", "Fire", ""],
  ["cry", "😭", "Cry", ""],
] as const;

export default function ShopPage() {
  return (
    <div className="relative min-h-screen">
      <InteractiveCasinoBg variant="subtle" />
      <NavigationBar currentPath="/shop" />
      <main className="relative z-10 mx-auto max-w-6xl px-4 pb-20 pt-24">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {EMOTES.map(([id, display, label, textClass]) => (
            <div key={id} className="rounded-2xl border border-[#00e5ff]/20 bg-[#040d24]/70 p-4 text-center shadow-[0_0_20px_rgba(0,229,255,0.08)]">
              <div className={`mx-auto flex h-24 w-24 items-center justify-center rounded-full border border-[#00e5ff]/40 bg-[#071531] text-5xl shadow-[0_0_18px_rgba(0,229,255,0.2)] ${textClass}`} role="img" aria-label={label}>
                <span className={id === "gg" || id === "nice-move" ? "text-center text-sm font-black leading-tight tracking-wider" : ""}>{display}</span>
              </div>
              <p className="mt-3 text-sm font-semibold text-[#c9f7ff]">{label}</p>
            </div>
          ))}
        </div>
      </main>
      <Footer />
    </div>
  );
}
