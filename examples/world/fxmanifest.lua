fx_version 'cerulean'
game 'gta5'
lua54 'yes'

name 'nexus_world_demo'
description 'A screen drawn on a prop with Nexus UI, and /worldtest to prove each link of the chain'
version '0.1.0'

ui_page 'web/dist/index.html'

files {
    'web/dist/index.html',
    'web/dist/**/*',
}

shared_scripts {
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
