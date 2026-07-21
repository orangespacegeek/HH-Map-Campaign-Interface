import { defineConfig } from '@prisma/config'

export default defineConfig({
  schema: './prisma/schema.prisma',
  datasource: {
    provider: 'sqlite',
    url: 'file:./dev.db'
  }
})
