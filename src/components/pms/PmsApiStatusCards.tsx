import {
  apiHealthBadgeClass,
  apiHealthStatusClass,
  apiHealthStatusLabel,
  type PmsApiHealthSnapshot,
  type PmsSystemApiHealth,
} from "@/lib/pmsApiHealth";

function SystemCard({ health }: { health: PmsSystemApiHealth }) {
  const occLabel = health.system === "SynXis" ? "S.OCC" : "E.OCC";
  const hkLabel = health.system === "SynXis" ? "SynXis HK" : "eZee HK";

  return (
    <div
      className={`rounded-lg border-2 px-4 py-3 ${apiHealthStatusClass(health.status)}`}
      role="status"
      aria-label={`${health.system} API ${apiHealthStatusLabel(health.status)}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-bold">{health.system} API</h3>
        <span
          className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${apiHealthBadgeClass(health.status)}`}
        >
          {apiHealthStatusLabel(health.status)}
        </span>
        <span className="text-xs opacity-80">via {health.sourceLabel}</span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <dt className="opacity-70">{occLabel} filled</dt>
          <dd className="font-semibold tabular-nums">
            {health.roomsWithOccupancy}/{health.inventoryRooms}
          </dd>
        </div>
        <div>
          <dt className="opacity-70">{hkLabel} filled</dt>
          <dd className="font-semibold tabular-nums">
            {health.roomsWithHk}/{health.inventoryRooms}
          </dd>
        </div>
        {health.roomsFromApi != null ? (
          <div>
            <dt className="opacity-70">API rooms</dt>
            <dd className="font-semibold tabular-nums">
              {health.roomsFromApi}/{health.inventoryRooms}
            </dd>
          </div>
        ) : null}
        {health.staleRoomsUsed != null && health.staleRoomsUsed > 0 ? (
          <div>
            <dt className="opacity-70">Stale Postgres</dt>
            <dd className="font-semibold tabular-nums">{health.staleRoomsUsed} rooms</dd>
          </div>
        ) : null}
      </dl>
      <p className="mt-2 text-xs leading-snug opacity-90">{health.detail}</p>
    </div>
  );
}

type Props = {
  health: PmsApiHealthSnapshot;
};

export function PmsApiStatusCards({ health }: Props) {
  return (
    <section className="grid gap-3 lg:grid-cols-2" aria-label="Per-API sync status">
      <SystemCard health={health.synxis} />
      <SystemCard health={health.ezee} />
    </section>
  );
}
