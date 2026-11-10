@echo off
title Simulador 3D Opel Corsa B 1998
echo Iniciando servidor local na porta 8080...
start http://localhost:8080
python -m http.server 8080

