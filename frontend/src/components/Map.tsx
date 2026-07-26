import React, { useState } from 'react';
import { MapContainer, ImageOverlay, Marker, Popup, Polyline } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// Fix default markers for Leaflet in React
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

interface Planet {
  id: number;
  name: string;
  position: [number, number];
  faction: string;
  powerLevel: number;
  infrastructure: string[];
  description: string;
}

const mockPlanets: Planet[] = [
  {
    id: 1,
    name: "Vespator Prime",
    position: [30, 40],
    faction: "Imperium",
    powerLevel: 4,
    infrastructure: ["Stronghold", "Staging Ground"],
    description: "Capital system. Heavily fortified.",
  },
  {
    id: 2,
    name: "Aetherius",
    position: [-20, -60],
    faction: "Chaos",
    powerLevel: 3,
    infrastructure: ["Fortification"],
    description: "Daemon-infested world.",
  },
  {
    id: 3,
    name: "Necron Tomb",
    position: [60, -30],
    faction: "Necrons",
    powerLevel: 2,
    infrastructure: ["Stronghold"],
    description: "Ancient xenos ruins.",
  },
  {
    id: 4,
    name: "Ultramar Outpost",
    position: [-50, 70],
    faction: "Imperium",
    powerLevel: 3,
    infrastructure: ["Staging Ground", "Fortification Line"],
    description: "Key supply hub.",
  },
];

const factionColors: { [key: string]: string } = {
  "Imperium": "#4ade80",
  "Chaos": "#f87171",
  "Necrons": "#a5b4fc",
};

export default function CampaignMap() {
  const [selectedPlanet, setSelectedPlanet] = useState<Planet | null>(null);

  // Sample connections (adjust coordinates to match your map image)
  const connections = [
    [[30, 40], [-20, -60]],
    [[-20, -60], [60, -30]],
    [[30, 40], [-50, 70]],
  ];

  return (
    <div className="w-full h-screen bg-zinc-950 flex flex-col">
      <div className="p-4 border-b border-zinc-800 flex justify-between items-center bg-black">
        <h1 className="text-3xl font-bold text-amber-400">VESPATOR FRONT SECTOR MAP</h1>
        <div className="flex gap-4 text-sm">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-emerald-500 rounded"></div> Imperium
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-red-500 rounded"></div> Chaos
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-indigo-400 rounded"></div> Xenos
          </div>
        </div>
      </div>

      <div className="flex-1 relative" style={{height: 'calc(100vh - 73px)'}}>
        <MapContainer
          center={[0, 0]}
          zoom={1}
          minZoom={0}
          maxZoom={4}
          style={{ height: '100%', width: '100%' }}
          className="z-0"
        >
          {/* Campaign Map Image Overlay */}
          <ImageOverlay
            url="/500-worlds-digital-map-campaign.webp"
            bounds={[[-100, -150], [100, 150]]}
            opacity={1}
          />

          {/* Connections */}
          {connections.map((line, index) => (
            <Polyline
              key={index}
              positions={line}
              color="#64748b"
              weight={2}
              opacity={0.7}
            />
          ))}

          {/* Planets */}
          {mockPlanets.map((planet) => {
            const color = factionColors[planet.faction] || '#ffffff';
            return (
              <Marker
                key={planet.id}
                position={planet.position}
                eventHandlers={{
                  click: () => setSelectedPlanet(planet),
                }}
              >
                <Popup>
                  <div className="text-left min-w-[200px]">
                    <h3 className="font-bold text-lg" style={{ color }}>{planet.name}</h3>
                    <p className="text-xs text-zinc-400">{planet.description}</p>
                    
                    <div className="mt-3 flex items-center gap-2">
                      <span className="text-xs uppercase tracking-widest">Faction:</span>
                      <span style={{ color }} className="font-semibold">{planet.faction}</span>
                    </div>

                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-xs uppercase tracking-widest">Power Level:</span>
                      <div className="flex">
                        {Array.from({ length: 4 }).map((_, i) => (
                          <span key={i} className={`text-xl ${i < planet.powerLevel ? 'text-amber-400' : 'text-zinc-700'}`}>★</span>
                        ))}
                      </div>
                    </div>

                    {planet.infrastructure.length > 0 && (
                      <div className="mt-3">
                        <span className="text-xs uppercase tracking-widest block mb-1">Infrastructure:</span>
                        <ul className="text-sm text-zinc-300">
                          {planet.infrastructure.map((inf, i) => (
                            <li key={i}>• {inf}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </Popup>
              </Marker>
            );
          })}
        </MapContainer>
      </div>

      {/* Side Panel for Details */}
      {selectedPlanet && (
        <div className="absolute top-20 right-4 bg-zinc-900 border border-zinc-700 p-6 rounded-xl shadow-2xl w-80 z-10">
          <button 
            onClick={() => setSelectedPlanet(null)}
            className="absolute top-3 right-3 text-zinc-400 hover:text-white"
          >
            ✕
          </button>
          <h2 className="text-2xl font-bold mb-4" style={{ color: factionColors[selectedPlanet.faction] }}>
            {selectedPlanet.name}
          </h2>
          <p className="text-zinc-400 mb-6">{selectedPlanet.description}</p>
          
          <div className="space-y-4">
            <div>
              <div className="uppercase text-xs tracking-widest text-zinc-500 mb-1">Control</div>
              <div className="flex items-center gap-3">
                <span className="text-4xl font-mono" style={{ color: factionColors[selectedPlanet.faction] }}>{selectedPlanet.faction}</span>
              </div>
            </div>

            <div>
              <div className="uppercase text-xs tracking-widest text-zinc-500 mb-1">Power Level</div>
              <div className="text-5xl font-bold text-amber-400 flex items-baseline gap-1">
                {selectedPlanet.powerLevel}
                <span className="text-base text-zinc-500">/4</span>
              </div>
            </div>

            <div>
              <div className="uppercase text-xs tracking-widest text-zinc-500 mb-2">Infrastructure</div>
              {selectedPlanet.infrastructure.map((inf, idx) => (
                <div key={idx} className="bg-zinc-800 px-3 py-2 rounded text-sm mb-1 flex items-center gap-2">
                  🛠️ {inf}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="absolute bottom-4 left-4 bg-zinc-900/90 px-4 py-2 rounded text-xs text-zinc-400 border border-zinc-700">
        Click planets for details • Drag to pan • Scroll to zoom • Faction colors indicate current control
      </div>
    </div>
  );
}

