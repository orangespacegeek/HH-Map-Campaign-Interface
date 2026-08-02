import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';

const app = express();
const prisma = new PrismaClient();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'HH Campaign Backend' });
});

// Load campaign
app.get('/api/campaign', async (_req, res) => {
  try {
    let campaign = await prisma.campaign.findFirst({
      include: { planets: true },
      orderBy: { updatedAt: 'desc' },
    });

    if (!campaign) {
      campaign = await prisma.campaign.create({
        data: {
          name: 'Vespator Front Campaign',
          planets: { create: [] },
        },
        include: { planets: true },
      });
    }

    const planets = campaign.planets.map((p) => ({
      id: p.id,
      name: p.name,
      position: [p.posY, p.posX] as [number, number],
      description: p.description,
      powerLevels: JSON.parse(p.powerLevels || '[]'),
      infrastructure: JSON.parse(p.infrastructure || '[]'),
      orbitFleets: JSON.parse(p.orbitFleets || '[]'),
    }));

    res.json({
      id: campaign.id,
      name: campaign.name,
      updatedAt: campaign.updatedAt,
      planets,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load campaign' });
  }
});

// Save campaign
app.put('/api/campaign', async (req, res) => {
  try {
    const { id, name, planets } = req.body;

    if (!Array.isArray(planets)) {
      return res.status(400).json({ error: 'planets array is required' });
    }

    let campaign;
    if (id) {
      campaign = await prisma.campaign.update({
        where: { id },
        data: { name: name || 'Vespator Front Campaign' },
      });
    } else {
      campaign = await prisma.campaign.create({
        data: { name: name || 'Vespator Front Campaign' },
      });
    }

    await prisma.planet.deleteMany({ where: { campaignId: campaign.id } });

    for (const p of planets) {
      await prisma.planet.create({
        data: {
          campaignId: campaign.id,
          name: p.name,
          posY: p.position[0],
          posX: p.position[1],
          description: p.description || '',
          powerLevels: JSON.stringify(p.powerLevels || []),
          infrastructure: JSON.stringify(p.infrastructure || []),
          orbitFleets: JSON.stringify(p.orbitFleets || []),
        },
      });
    }

    const updated = await prisma.campaign.findUnique({
      where: { id: campaign.id },
      include: { planets: true },
    });

    res.json({
      success: true,
      id: campaign.id,
      updatedAt: updated?.updatedAt,
      planetCount: updated?.planets.length ?? 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save campaign' });
  }
});

app.listen(PORT, () => {
  console.log(`HH Campaign Backend running on http://localhost:${PORT}`);
});
