import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch, type SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { Text } from "react-native";
import { markConsumedRpc, previewNowRpc, statusRpc } from "../shared/rpc";
import { archiverSettings, PLUGIN_VERSION, readinessBlockers, type ArchiverConfig } from "../shared/settings";

type InputRef = SettingsInputHandle;

// Administration only: mode, pause, versioned readiness evidence, mark-consumed and on-demand preview.
export function ArchiverSettings() {
  const settings = useSettings(archiverSettings);
  const status = useRpc(statusRpc);
  const preview = useRpc(previewNowRpc);
  const mark = useRpc(markConsumedRpc);
  const [report, setReport] = useState("");
  const restore = useRef<InputRef>(null);
  const heartbeat = useRef<InputRef>(null);
  const identity = useRef<InputRef>(null);
  const agent = useRef<InputRef>(null);

  if (settings.status !== "ready") {
    return <SettingsSection title="Session archiver"><SettingsCard><SettingsRow label="Settings" hint={settings.status === "loading" ? "Loading" : settings.error} /></SettingsCard></SettingsSection>;
  }
  const values = settings.values;
  const set = (patch: Partial<ArchiverConfig>) => void settings.save({ ...values, ...patch }, settings.revision);
  const blockers = readinessBlockers(values);
  const show = (value: unknown) => setReport(JSON.stringify(value, null, 1));

  return (
    <SettingsSection title="Session archiver">
      <SettingsCard>
        <SettingsSelect label="Mode" value={values.mode} hint={blockers.length ? `Acts as preview: ${blockers.join(", ")}` : undefined}
          options={[{ label: "Preview", value: "preview" }, { label: "Archive", value: "archive" }]}
          onValueChange={mode => set({ mode: mode === "archive" ? "archive" : "preview" })} disabled={settings.saving} />
        <SettingsSwitch label="Paused" value={values.paused} onValueChange={paused => set({ paused })} disabled={settings.saving} />
        {settings.saveError ? <SettingsRow label="Save failed" error={settings.saveError} /> : null}
      </SettingsCard>
      <SettingsCard>
        <SettingsInput ref={restore} label="Restore evidence" hint="docker:YYYY-MM-DD:<run id>" initialValue={values.readiness.restoreEvidence} onChangeText={() => {}} />
        <SettingsInput ref={heartbeat} label="Heartbeat coverage evidence" initialValue={values.readiness.heartbeatEvidence} onChangeText={() => {}} />
        <SettingsInput ref={identity} label="Turn bumps updatedAt evidence" initialValue={values.readiness.turnBumpsUpdatedAtEvidence} onChangeText={() => {}} />
        <SettingsAction label={`Attest readiness for ${PLUGIN_VERSION}`} actionLabel="Save" disabled={settings.saving}
          onPress={() => set({ readiness: { pluginVersion: PLUGIN_VERSION, restoreEvidence: restore.current?.getText() ?? "", heartbeatEvidence: heartbeat.current?.getText() ?? "", turnBumpsUpdatedAtEvidence: identity.current?.getText() ?? "" } })} />
      </SettingsCard>
      <SettingsCard>
        <SettingsInput ref={agent} label="Helper agent ID" placeholder="agent id" onChangeText={() => {}} />
        <SettingsAction label="Mark current result consumed" actionLabel="Mark"
          onPress={() => { const agentId = agent.current?.getText().trim() ?? ""; if (agentId) void mark({ agentId }).then(show, () => setReport("mark failed")); }} />
        <SettingsAction label="Status" actionLabel="Refresh" onPress={() => void status({}).then(s => show({ sdkContext: s.sdkContext, nextPassAt: s.nextPassAt, diagnostics: s.diagnostics, lastPass: s.lastPass }), () => setReport("status failed"))} />
        <SettingsAction label="Preview now" actionLabel="Run" onPress={() => void preview({}).then(p => show(p.summary ?? { reason: p.reason }), () => setReport("preview failed"))} />
        {report ? <SettingsRow label="Result"><Text selectable>{report}</Text></SettingsRow> : null}
      </SettingsCard>
    </SettingsSection>
  );
}
