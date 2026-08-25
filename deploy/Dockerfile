# Build:  docker build -f deploy/Dockerfile -t lanelet-inspector .
# Run:    docker run -p 8080:80 lanelet-inspector
FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm run data && npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
# the container serves on :80; the server_name line above is ignored by default_server
RUN sed -i 's|server_name .*|server_name _;|; s|root .*|root /usr/share/nginx/html;|' /etc/nginx/conf.d/default.conf
EXPOSE 80
