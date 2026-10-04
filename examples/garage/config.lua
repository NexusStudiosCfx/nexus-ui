Config = {}

-- The language of the page: a file name from locales/, without the extension. Set it for every
-- player with `setr nexus_garage_locale es` in server.cfg.
Config.locale = GetConvar('nexus_garage_locale', 'en')

-- What every player has to spend. This demo keeps money in memory: it is back to this amount
-- after a restart, and it has nothing to do with the money of a framework.
Config.startingBalance = 60000

-- speed, acceleration and handling are scores from 0 to 100, shown as bars.
Config.vehicles = {
    { model = 'blista', label = 'Blista', class = 'compact', price = 8000, speed = 48, acceleration = 46, handling = 62 },
    { model = 'sanchez', label = 'Sanchez', class = 'motorcycle', price = 9500, speed = 54, acceleration = 66, handling = 70 },
    { model = 'baller', label = 'Baller', class = 'suv', price = 22000, speed = 58, acceleration = 50, handling = 48 },
    { model = 'sultan', label = 'Sultan', class = 'sports', price = 28000, speed = 68, acceleration = 70, handling = 72 },
    { model = 'bati', label = 'Bati 801', class = 'motorcycle', price = 31000, speed = 82, acceleration = 88, handling = 76 },
    { model = 'elegy2', label = 'Elegy RH8', class = 'sports', price = 46000, speed = 76, acceleration = 78, handling = 80 },
    { model = 'comet2', label = 'Comet', class = 'sports', price = 58000, speed = 80, acceleration = 82, handling = 74 },
    { model = 'banshee', label = 'Banshee', class = 'sports', price = 64000, speed = 84, acceleration = 80, handling = 70 },
    { model = 'zentorno', label = 'Zentorno', class = 'super', price = 185000, speed = 96, acceleration = 94, handling = 86 },
}
