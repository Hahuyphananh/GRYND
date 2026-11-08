// Local type shim: the repo does not install @types/react-dom, and this app is
// typechecked in strict mode (unlike the other standalone build). Only the one
// `createRoot` entry point this app uses is declared.
declare module "react-dom/client" {
  import type { ReactNode } from "react";

  export interface Root {
    render(children: ReactNode): void;
    unmount(): void;
  }

  export function createRoot(container: Element | DocumentFragment): Root;
}
