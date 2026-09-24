import { Stack } from "expo-router";

export default function CustomersStackLayout() {
  return <Stack screenOptions={{ headerShown: false, animation: "slide_from_right" }} />;
}
