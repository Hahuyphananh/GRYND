import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import ProTrialTimeline from "../src/components/ProTrialTimeline.tsx";

// The real component with the real state wiring: the reminder choice is owned
// by the parent (as it is in UpgradeProContent) and echoed into a data
// attribute, so the browser test can assert that a CLICK reached paywall state.
function Harness() {
  const [reminderDays, setReminderDays] = useState(3);
  return (
    <div style={{ maxWidth: 560, margin: "40px auto", padding: 16 }}>
      <output
        data-testid="paywall-harness-reminder"
        data-reminder={reminderDays}
      >
        {reminderDays}
      </output>
      <ProTrialTimeline
        priceDisplay="CA$4.99"
        unit="month"
        reminderDays={reminderDays}
        onReminderChange={setReminderDays}
      />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);
