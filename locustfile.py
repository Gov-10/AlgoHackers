from locust import HttpUser, task

class FloodUser(HttpUser):

    @task
    def spam(self):
        self.client.get("/metadata")
