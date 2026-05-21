FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
# Dùng 'npm ci' thay vì 'npm install' để bảo mật và nhanh hơn
RUN npm ci --only=production
COPY . .
# Chạy dọn dẹp cache của npm để giảm dung lượng image
RUN npm cache clean --force
RUN mkdir -p temp_audio && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "start"]
