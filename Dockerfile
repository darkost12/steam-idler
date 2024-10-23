FROM node:18

ADD https://github.com/darkost12/steam-idler/archive/refs/heads/main.zip .

RUN set -ex ;\
  apt-get update ;\
  apt-get install unzip ;\
  unzip main.zip

WORKDIR /steam-idler-main

RUN set -ex ;\
  npm install

ENV HOME=/steam-idler-main/shared

CMD node idler.js
