import { SignUp } from "@clerk/nextjs";

export default function Page() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#001a33]">
      <SignUp
        afterSignUpUrl="/sync"
        appearance={{
          variables: {
            colorPrimary: "#FFD700", // gold
            colorBackground: "#033360ff",
            colorText: "#FFD700",
            colorInputBackground: "#002b55",
            colorInputText: "#FFD700",
            borderRadius: "0.75rem",
            fontFamily: "Inter, sans-serif",
          },
          elements: {
            card: "shadow-2xl border border-[#FFD700]/30",
            headerTitle: "text-[#FFD700]",
            headerSubtitle: "text-[#FFD700]/70",
            socialButtonsBlockButton:
              "bg-[#002b55] border border-[#FFD700]/30 hover:bg-[#003366]",
            formButtonPrimary:
              "bg-[#FFD700] text-[#001a33] hover:bg-[#ffdf33]",
            footerActionLink: "text-[#FFD700] hover:text-[#ffdf33]",
          },
        }}
      />
    </div>
  );
}
