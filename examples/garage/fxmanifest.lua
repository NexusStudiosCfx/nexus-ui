fx_version 'cerulean'
game 'gta5'
lua54 'yes'

name 'nexus_garage_demo'
description 'A garage menu and a vehicle HUD built with Nexus UI'
version '0.1.0'

ui_page 'web/dist/index.html'

files {
    'web/dist/index.html',
    'web/dist/**/*',
    'locales/*.json',
}

shared_scripts {
    'config.lua',
    'nexus/contract.lua',
}

client_scripts {
    'nexus/screens.lua',
    'nexus/client.lua',
    'client/main.lua',
}

server_scripts {
    'nexus/server.lua',
    'server/main.lua',
}
