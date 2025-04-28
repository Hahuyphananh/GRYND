import {config} from 'dotenv'
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)
const db = drizzle(sql)
config({path: 'env.local'})

export { db }

