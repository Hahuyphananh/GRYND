"use server"
import { db } from "./index";
import { migrate } from "drizzle-orm/neon-http/migrator";

const main = async() => {
    try {
        await migrate(db, {
            migrationsFolder: 'src/db/migrations'
        })

        console.log('migration completed')
    } catch (error) {
            console.log('error during migration: ', error)
            process.exit(1)
    }
}
main()