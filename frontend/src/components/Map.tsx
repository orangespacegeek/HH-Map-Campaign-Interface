import React, { useState } from 'react';
import { MapContainer, ImageOverlay, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// ============================================================================
// CORE MECHANIC: Fix Leaflet default marker icons (required for Vite/React bundling)
// ============================================================================
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

// ============================================================================
// 500 WORLDS SYSTEM DATA
// These come from the official Vespator Front campaign map / sticker sheet.
// - Power Levels (1-4) exist PER ALLIANCE on every planet
// - Infrastructure is built by a specific Alliance into limited slots on the planet
// - Orbit locations hold any number of Fleet stickers
// - Connections determine legal Movement / Attack Operations
// ============================================================================

/** Official Alliances used in a standard 3-Alliance Vespator Front campaign */
type Alliance = 'Imperium' | 'Chaos' | 'Xenos';

interface PowerLevelEntry {
  alliance: Alliance;
  level: number; // 1–4 (500 Worlds rule: cannot go below 1 or above 4)
}

interface InfrastructureEntry {
  type: string;          // e.g. "Stronghold", "Staging Ground", "Fortification", "Support Facility"
  owner: Alliance;       // Which Alliance built it
  slot: number;          // Slot index on the planet
}

interface Planet {
  id: number;
  name: string;
  // Position uses the Simple CRS coordinate system matching the map image pixels
  // (y, x) where [0,0] is bottom-left of the image
  position: [number, number];
  // 500 Worlds: Power Level for EVERY Alliance on this planet
  powerLevels: PowerLevelEntry[];
  // 500 Worlds: Infrastructure pieces currently built (limited slots)
  infrastructure: InfrastructureEntry[];
  // 500 Worlds: Fleets currently in orbit (unlimited)
  orbitFleets: Alliance[];
  description: string;
}

// ============================================================================
// 500 WORLDS MAP DATA – Initial campaign state
// Planet positions are approximate and should be refined by visually aligning
// markers to the planet nodes printed on 500-worlds-digital-map-campaign.webp
// ============================================================================
const initialPlanets: Planet[] = [
  {
    id: 1,
    name: "Vespator Prime",
    position: [2800, 2700],
    powerLevels: [
      { alliance: 'Imperium', level: 4 },
      { alliance: 'Chaos', level: 2 },
      { alliance: 'Xenos', level: 1 },
    ],
    infrastructure: [
      { type: 'Stronghold', owner: 'Imperium', slot: 1 },
      { type: 'Staging Ground', owner: 'Imperium', slot: 2 },
      { type: 'Fortification', owner: 'Chaos', slot: 3 },
    ],
    orbitFleets: ['Imperium', 'Imperium', 'Chaos'],
    description: "Primary system of the Vespator Front. Heavily fortified Imperial stronghold.",
  },
  {
    id: 2,
    name: "Aetherius",
    position: [1800, 1500],
    powerLevels: [
      { alliance: 'Imperium', level: 1 },
      { alliance: 'Chaos', level: 4 },
      { alliance: 'Xenos', level: 2 },
    ],
    infrastructure: [
      { type: 'Stronghold', owner: 'Chaos', slot: 1 },
      { type: 'Support Facility', owner: 'Chaos', slot: 2 },
    ],
    orbitFleets: ['Chaos', 'Chaos'],
    description: "Daemon-tainted world. High Chaos Power Level.",
  },
  {
    id: 3,
    name: "Necron Tomb World",
    position: [1200, 3800],
    powerLevels: [
      { alliance: 'Imperium', level: 2 },
      { alliance: 'Chaos', level: 1 },
      { alliance: 'Xenos', level: 3 },
    ],
    infrastructure: [
      { type: 'Stronghold', owner: 'Xenos', slot: 1 },
    ],
    orbitFleets: ['Xenos'],
    description: "Ancient xenos tomb complex awakening on the frontier.",
  },
  {
    id: 4,
    name: "Ultramar Outpost",
    position: [3200, 1200],
    powerLevels: [
      { alliance: 'Imperium', level: 3 },
      { alliance: 'Chaos', level: 2 },
      { alliance: 'Xenos', level: 1 },
    ],
    infrastructure: [
      { type: 'Staging Ground', owner: 'Imperium', slot: 1 },
      { type: 'Fortification Line', owner: 'Imperium', slot: 2 },
    ],
    orbitFleets: ['Imperium'],
    description: "Key Imperial supply and staging hub for the sector.",
  },
  {
    id: 5,
    name: "Xenoflora Reach",
    position: [2200, 4200],
    powerLevels: [
      { alliance: 'Imperium', level: 1 },
      { alliance: 'Chaos', level: 2 },
      { alliance: 'Xenos', level: 3 },
    ],
    infrastructure: [],
    orbitFleets: [],
    description: "Jungle world covered in aggressive xenoflora. Theatre rules apply.",
  },
];

// ============================================================================
// CORE MECHANIC: Alliance colour coding
// ============================================================================
const allianceColors: Record<Alliance | 'Contested', string> = {
  Imperium: '#4ade80',
  Chaos: '#f87171',
  Xenos: '#fbbf24',
  Contested: '#94a3b8',
};

// 500 Worlds: Common infrastructure types from the campaign
const INFRASTRUCTURE_TYPES = [
  'Stronghold',
  'Staging Ground',
  'Fortification',
  'Fortification Line',
  'Support Facility',
];

// ============================================================================
// 500 WORLDS HELPER: Determine controlling Alliance from Power Levels
// Highest Power Level wins. Tie = Contested.
// ============================================================================
function getControllingAlliance(planet: Planet): Alliance | 'Contested' {
  const sorted = [...planet.powerLevels].sort((a, b) => b.level - a.level);
  if (sorted[0].level === sorted[1].level) return 'Contested';
  return sorted[0].alliance;
}

// ============================================================================
// 500 WORLDS SYSTEM: Connections between planets
// ============================================================================
const connections: [number, number][][] = [
  [[2800, 2700], [1800, 1500]],
  [[1800, 1500], [1200, 3800]],
  [[2800, 2700], [3200, 1200]],
  [[2800, 2700], [2200, 4200]],
  [[3200, 1200], [1800, 1500]],
];

// ============================================================================
// CORE MECHANIC: Keep the map centered on the image
// ============================================================================
function FitBounds() {
  const map = useMap();
  React.useEffect(() => {
    const bounds: L.LatLngBoundsExpression = [[0, 0], [3750, 5400]];
    map.fitBounds(bounds, { padding: [20, 20] });
  }, [map]);
  return null;
}

// ============================================================================
// CORE UI: Power Level stars display
// ============================================================================
function PowerStars({ level }: { level: number }) {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: 4 }).map((_, i) => (
        <span
          key={i}
          className={`text-sm ${i < level ? 'text-amber-400' : 'text-zinc-600'}`}
        >
          ★
        </span>
      ))}
    </div>
  );
}

// ============================================================================
// CORE UI: Confirmation dialog state & component
// ============================================================================
interface ConfirmDialogState {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
}

function ConfirmDialog({
  dialog,
  onCancel,
}: {
  dialog: ConfirmDialogState;
  onCancel: () => void;
}) {
  if (!dialog.open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="bg-zinc-900 border border-zinc-600 rounded-xl p-6 w-full max-w-md shadow-2xl">
        <h3 className="text-lg font-bold text-amber-400 mb-2">{dialog.title}</h3>
        <p className="text-zinc-300 text-sm mb-6">{dialog.message}</p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded bg-zinc-700 hover:bg-zinc-600 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              dialog.onConfirm();
              onCancel();
            }}
            className="px-4 py-2 rounded bg-red-600 hover:bg-red-500 text-sm font-medium text-white"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// CORE: Backend API base URL (backend runs on port 3001)
const API_BASE = 'http://localhost:3001/api';

export default function CampaignMap() {
  // CORE: Campaign state
  const [planets, setPlanets] = useState<Planet[]>(initialPlanets);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [selectedPlanetId, setSelectedPlanetId] = useState<number | null>(null);
  // CORE: GM / Warmaster edit mode toggle
  const [editMode, setEditMode] = useState(false);
  // CORE: Save status
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // CORE: Confirmation dialog
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    open: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const selectedPlanet = planets.find(p => p.id === selectedPlanetId) || null;

  const closeConfirm = () =>
    setConfirmDialog(prev => ({ ...prev, open: false }));

  const askConfirm = (title: string, message: string, onConfirm: () => void) => {
    setConfirmDialog({ open: true, title, message, onConfirm });
  };

  // --------------------------------------------------------------------------
  // CORE: Load campaign from backend on mount
  // --------------------------------------------------------------------------
  React.useEffect(() => {
    fetch(`${API_BASE}/campaign`)
      .then(res => res.json())
      .then(data => {
        if (data.planets && data.planets.length > 0) {
          // Map backend IDs (strings) to our numeric local IDs for now
          // Keep positions etc. from server
          setPlanets(
            data.planets.map((p: any, idx: number) => ({
              ...p,
              id: idx + 1, // keep local numeric ids for React keys
            }))
          );
          setCampaignId(data.id);
        }
      })
      .catch(err => {
        console.warn('Could not load campaign from backend – using local defaults', err);
      });
  }, []);

  // --------------------------------------------------------------------------
  // CORE: Save campaign to backend
  // --------------------------------------------------------------------------
  const saveCampaign = async () => {
    setSaveStatus('saving');
    try {
      const payload = {
        id: campaignId,
        name: 'Vespator Front Campaign',
        planets: planets.map(p => ({
          name: p.name,
          position: p.position,
          description: p.description,
          powerLevels: p.powerLevels,
          infrastructure: p.infrastructure,
          orbitFleets: p.orbitFleets,
        })),
      };

      const res = await fetch(`${API_BASE}/campaign`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error('Save failed');

      const data = await res.json();
      setCampaignId(data.id);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2500);
    } catch (err) {
      console.error(err);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  };

  // Image native size
  const IMAGE_WIDTH = 5400;
  const IMAGE_HEIGHT = 3750;
  const imageBounds: L.LatLngBoundsExpression = [[0, 0], [IMAGE_HEIGHT, IMAGE_WIDTH]];

  // --------------------------------------------------------------------------
  // 500 WORLDS EDIT HELPERS (GM / Warmaster only)
  // --------------------------------------------------------------------------

  const updatePowerLevel = (planetId: number, alliance: Alliance, newLevel: number) => {
    // 500 Worlds rule: Power Level cannot go below 1 or above 4
    const clamped = Math.max(1, Math.min(4, newLevel));
    setPlanets(prev =>
      prev.map(p => {
        if (p.id !== planetId) return p;
        return {
          ...p,
          powerLevels: p.powerLevels.map(pl =>
            pl.alliance === alliance ? { ...pl, level: clamped } : pl
          ),
        };
      })
    );
  };

  const addInfrastructure = (planetId: number, type: string, owner: Alliance) => {
    setPlanets(prev =>
      prev.map(p => {
        if (p.id !== planetId) return p;
        const nextSlot = p.infrastructure.length + 1;
        return {
          ...p,
          infrastructure: [
            ...p.infrastructure,
            { type, owner, slot: nextSlot },
          ],
        };
      })
    );
  };

  const removeInfrastructure = (planetId: number, slot: number, type: string, owner: Alliance) => {
    askConfirm(
      'Remove Infrastructure?',
      `Remove ${type} owned by ${owner} from this planet? This cannot be undone.`,
      () => {
        setPlanets(prev =>
          prev.map(p => {
            if (p.id !== planetId) return p;
            return {
              ...p,
              infrastructure: p.infrastructure.filter(inf => inf.slot !== slot),
            };
          })
        );
      }
    );
  };

  const addOrbitFleet = (planetId: number, alliance: Alliance) => {
    setPlanets(prev =>
      prev.map(p => {
        if (p.id !== planetId) return p;
        return {
          ...p,
          orbitFleets: [...p.orbitFleets, alliance],
        };
      })
    );
  };

  const removeOrbitFleet = (planetId: number, index: number, alliance: Alliance) => {
    askConfirm(
      'Remove Fleet?',
      `Remove this ${alliance} fleet from orbit? This cannot be undone.`,
      () => {
        setPlanets(prev =>
          prev.map(p => {
            if (p.id !== planetId) return p;
            return {
              ...p,
              orbitFleets: p.orbitFleets.filter((_, i) => i !== index),
            };
          })
        );
      }
    );
  };

  return (
    <div className="w-full h-screen bg-zinc-950 flex flex-col">
      {/* Header – CORE UI */}
      <div className="p-4 border-b border-zinc-800 flex justify-between items-center bg-black">
        <h1 className="text-3xl font-bold text-amber-400">VESPATOR FRONT SECTOR MAP</h1>

        <div className="flex items-center gap-6">
          {/* Alliance legend */}
          <div className="flex gap-4 text-sm">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded" style={{ background: allianceColors.Imperium }}></div> Imperium
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded" style={{ background: allianceColors.Chaos }}></div> Chaos
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded" style={{ background: allianceColors.Xenos }}></div> Xenos
            </div>
          </div>

          {/* CORE: Save Campaign button */}
          <button
            onClick={saveCampaign}
            disabled={saveStatus === 'saving'}
            className={`px-4 py-1.5 rounded text-sm font-semibold transition-colors ${
              saveStatus === 'saved'
                ? 'bg-emerald-600 text-white'
                : saveStatus === 'error'
                ? 'bg-red-600 text-white'
                : saveStatus === 'saving'
                ? 'bg-zinc-600 text-zinc-300 cursor-wait'
                : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
            }`}
          >
            {saveStatus === 'saving'
              ? 'Saving…'
              : saveStatus === 'saved'
              ? '✓ Saved'
              : saveStatus === 'error'
              ? 'Save Failed'
              : 'Save Campaign'}
          </button>

          {/* CORE: GM Edit Mode Toggle */}
          <button
            onClick={() => setEditMode(!editMode)}
            className={`px-4 py-1.5 rounded text-sm font-semibold transition-colors ${
              editMode
                ? 'bg-amber-500 text-black'
                : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
            }`}
          >
            {editMode ? '⚔ WARMASTER MODE' : 'Enter Warmaster Mode'}
          </button>
        </div>
      </div>

      {/* Map Container – CORE UI */}
      <div className="flex-1 relative" style={{ height: 'calc(100vh - 73px)' }}>
        <MapContainer
          crs={L.CRS.Simple}
          center={[IMAGE_HEIGHT / 2, IMAGE_WIDTH / 2]}
          zoom={-1}
          minZoom={-2}
          maxZoom={2}
          style={{ height: '100%', width: '100%', background: '#111827' }}
          className="z-0"
          maxBounds={imageBounds}
          maxBoundsViscosity={1.0}
        >
          <FitBounds />

          {/* 500 WORLDS MAP LAYER */}
          <ImageOverlay
            url="/500-worlds-digital-map-campaign.webp"
            bounds={imageBounds}
            opacity={1}
          />

          {/* 500 WORLDS SYSTEM: Planet Connections */}
          {connections.map((line, index) => (
            <Polyline
              key={index}
              positions={line}
              pathOptions={{
                color: '#94a3b8',
                weight: 3,
                opacity: 0.6,
                dashArray: '8 6',
              }}
            />
          ))}

          {/* 500 WORLDS SYSTEM: Planet Markers */}
          {planets.map((planet) => {
            const controller = getControllingAlliance(planet);
            const color = allianceColors[controller];
            return (
              <Marker
                key={planet.id}
                position={planet.position}
                eventHandlers={{
                  click: () => setSelectedPlanetId(planet.id),
                }}
              >
                <Popup maxWidth={320}>
                  <div className="text-left min-w-[260px]">
                    <h3 className="font-bold text-lg mb-1" style={{ color }}>{planet.name}</h3>
                    <p className="text-xs text-zinc-500 mb-3">{planet.description}</p>

                    <div className="mb-3">
                      <div className="text-xs uppercase tracking-widest text-zinc-500 mb-1">Power Levels</div>
                      {planet.powerLevels.map((pl) => (
                        <div key={pl.alliance} className="flex items-center justify-between py-0.5">
                          <span style={{ color: allianceColors[pl.alliance] }} className="text-sm font-medium">
                            {pl.alliance}
                          </span>
                          <PowerStars level={pl.level} />
                        </div>
                      ))}
                    </div>

                    {planet.infrastructure.length > 0 && (
                      <div className="mb-2">
                        <div className="text-xs uppercase tracking-widest text-zinc-500 mb-1">Infrastructure</div>
                        {planet.infrastructure.map((inf, i) => (
                          <div key={i} className="flex items-center justify-between text-sm py-0.5">
                            <span>🛠️ {inf.type}</span>
                            <span style={{ color: allianceColors[inf.owner] }} className="text-xs font-medium">
                              {inf.owner}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {planet.orbitFleets.length > 0 && (
                      <div>
                        <div className="text-xs uppercase tracking-widest text-zinc-500 mb-1">Fleets in Orbit</div>
                        <div className="flex flex-wrap gap-1">
                          {planet.orbitFleets.map((fleet, i) => (
                            <span
                              key={i}
                              className="text-xs px-1.5 py-0.5 rounded"
                              style={{ background: allianceColors[fleet] + '33', color: allianceColors[fleet] }}
                            >
                              {fleet}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </Popup>
              </Marker>
            );
          })}
        </MapContainer>
      </div>

      {/* ============================================================
          DETAIL SIDE PANEL – View + GM Edit Mode
          ============================================================ */}
      {selectedPlanet && (
        <div className="absolute top-20 right-4 bg-zinc-900 border border-zinc-700 p-5 rounded-xl shadow-2xl w-96 z-10 max-h-[80vh] overflow-y-auto">
          <button
            onClick={() => setSelectedPlanetId(null)}
            className="absolute top-3 right-3 text-zinc-400 hover:text-white text-lg"
          >
            ✕
          </button>

          <div className="flex items-center gap-2 mb-1">
            <h2
              className="text-2xl font-bold pr-6"
              style={{ color: allianceColors[getControllingAlliance(selectedPlanet)] }}
            >
              {selectedPlanet.name}
            </h2>
            {editMode && (
              <span className="text-xs bg-amber-500 text-black px-2 py-0.5 rounded font-bold">
                EDITING
              </span>
            )}
          </div>
          <p className="text-zinc-400 text-sm mb-5">{selectedPlanet.description}</p>

          {/* Controlling Alliance */}
          <div className="mb-5">
            <div className="uppercase text-xs tracking-widest text-zinc-500 mb-1">Controlling Alliance</div>
            <div
              className="text-xl font-semibold"
              style={{ color: allianceColors[getControllingAlliance(selectedPlanet)] }}
            >
              {getControllingAlliance(selectedPlanet)}
            </div>
          </div>

          {/* ============================================================
              500 WORLDS: Power Levels (editable in GM mode)
              ============================================================ */}
          <div className="mb-5">
            <div className="uppercase text-xs tracking-widest text-zinc-500 mb-2">Power Levels (1–4)</div>
            <div className="space-y-2">
              {selectedPlanet.powerLevels.map((pl) => (
                <div
                  key={pl.alliance}
                  className="flex items-center justify-between bg-zinc-800/80 px-3 py-2 rounded"
                >
                  <span className="font-medium" style={{ color: allianceColors[pl.alliance] }}>
                    {pl.alliance}
                  </span>
                  <div className="flex items-center gap-2">
                    {editMode ? (
                      <>
                        <button
                          onClick={() => updatePowerLevel(selectedPlanet.id, pl.alliance, pl.level - 1)}
                          className="w-7 h-7 rounded bg-zinc-700 hover:bg-zinc-600 text-white font-bold"
                          disabled={pl.level <= 1}
                        >
                          −
                        </button>
                        <span className="text-lg font-bold text-amber-400 w-4 text-center">{pl.level}</span>
                        <button
                          onClick={() => updatePowerLevel(selectedPlanet.id, pl.alliance, pl.level + 1)}
                          className="w-7 h-7 rounded bg-zinc-700 hover:bg-zinc-600 text-white font-bold"
                          disabled={pl.level >= 4}
                        >
                          +
                        </button>
                      </>
                    ) : (
                      <>
                        <PowerStars level={pl.level} />
                        <span className="text-lg font-bold text-amber-400 w-4 text-right">{pl.level}</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ============================================================
              500 WORLDS: Infrastructure (editable in GM mode)
              ============================================================ */}
          <div className="mb-5">
            <div className="uppercase text-xs tracking-widest text-zinc-500 mb-2">
              Infrastructure ({selectedPlanet.infrastructure.length})
            </div>

            {selectedPlanet.infrastructure.length > 0 ? (
              <div className="space-y-1.5 mb-3">
                {selectedPlanet.infrastructure.map((inf) => (
                  <div
                    key={inf.slot}
                    className="bg-zinc-800 px-3 py-2 rounded text-sm flex items-center justify-between"
                  >
                    <span>🛠️ {inf.type}</span>
                    <div className="flex items-center gap-2">
                      <span
                        className="text-xs font-semibold px-2 py-0.5 rounded"
                        style={{
                          background: allianceColors[inf.owner] + '22',
                          color: allianceColors[inf.owner],
                        }}
                      >
                        {inf.owner}
                      </span>
                      {editMode && (
                        <button
                          onClick={() =>
                            removeInfrastructure(
                              selectedPlanet.id,
                              inf.slot,
                              inf.type,
                              inf.owner
                            )
                          }
                          className="text-red-400 hover:text-red-300 text-xs"
                          title="Remove infrastructure"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-zinc-500 text-sm mb-3">No infrastructure built yet</div>
            )}

            {/* GM: Add Infrastructure */}
            {editMode && (
              <div className="border border-zinc-700 rounded p-3 space-y-2">
                <div className="text-xs text-zinc-400 mb-1">Add Infrastructure</div>
                <select
                  id="inf-type"
                  className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-1.5 text-sm"
                  defaultValue=""
                >
                  <option value="" disabled>Select type…</option>
                  {INFRASTRUCTURE_TYPES.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <select
                  id="inf-owner"
                  className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-1.5 text-sm"
                  defaultValue="Imperium"
                >
                  <option value="Imperium">Imperium</option>
                  <option value="Chaos">Chaos</option>
                  <option value="Xenos">Xenos</option>
                </select>
                <button
                  onClick={() => {
                    const typeEl = document.getElementById('inf-type') as HTMLSelectElement;
                    const ownerEl = document.getElementById('inf-owner') as HTMLSelectElement;
                    if (typeEl.value) {
                      addInfrastructure(selectedPlanet.id, typeEl.value, ownerEl.value as Alliance);
                      typeEl.value = '';
                    }
                  }}
                  className="w-full bg-amber-600 hover:bg-amber-500 text-black font-semibold py-1.5 rounded text-sm"
                >
                  + Add Infrastructure
                </button>
              </div>
            )}
          </div>

          {/* ============================================================
              500 WORLDS: Orbit Fleets (editable in GM mode)
              ============================================================ */}
          <div>
            <div className="uppercase text-xs tracking-widest text-zinc-500 mb-2">
              Fleets in Orbit ({selectedPlanet.orbitFleets.length})
            </div>

            {selectedPlanet.orbitFleets.length > 0 ? (
              <div className="flex flex-wrap gap-2 mb-3">
                {selectedPlanet.orbitFleets.map((fleet, i) => (
                  <span
                    key={i}
                    className="text-xs px-2.5 py-1 rounded font-medium flex items-center gap-1"
                    style={{
                      background: allianceColors[fleet] + '33',
                      color: allianceColors[fleet],
                      border: `1px solid ${allianceColors[fleet]}55`,
                    }}
                  >
                    {fleet} Fleet
                    {editMode && (
                      <button
                        onClick={() => removeOrbitFleet(selectedPlanet.id, i, fleet)}
                        className="ml-1 hover:text-white"
                      >
                        ✕
                      </button>
                    )}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-zinc-500 text-sm mb-3">No fleets currently in orbit</div>
            )}

            {/* GM: Add Fleet */}
            {editMode && (
              <div className="flex gap-2">
                {(['Imperium', 'Chaos', 'Xenos'] as Alliance[]).map(alliance => (
                  <button
                    key={alliance}
                    onClick={() => addOrbitFleet(selectedPlanet.id, alliance)}
                    className="flex-1 text-xs py-1.5 rounded font-medium"
                    style={{
                      background: allianceColors[alliance] + '33',
                      color: allianceColors[alliance],
                      border: `1px solid ${allianceColors[alliance]}55`,
                    }}
                  >
                    + {alliance}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* CORE UI: Help text */}
      <div className="absolute bottom-4 left-4 bg-zinc-900/90 px-4 py-2 rounded text-xs text-zinc-400 border border-zinc-700">
        {editMode
          ? '⚔ Warmaster Mode active — click a planet to edit Power Levels, Infrastructure & Fleets'
          : 'Click planets for details • Drag to pan • Scroll to zoom • Toggle Warmaster Mode to edit'}
      </div>

      {/* CORE UI: Confirmation Dialog */}
      <ConfirmDialog dialog={confirmDialog} onCancel={closeConfirm} />
    </div>
  );
}
