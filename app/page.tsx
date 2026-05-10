import { redirect } from "next/navigation";

// Redirect is static — no dynamic directive needed.
export default function RootPage() {
  redirect("/forecast");
}
