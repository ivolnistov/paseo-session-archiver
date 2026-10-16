import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ArchiverSettings } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  const remove = client.addSettingsScreen({ id: "archiver", title: "Session archiver", icon: "archive", Component: ArchiverSettings });
  return () => remove();
}
